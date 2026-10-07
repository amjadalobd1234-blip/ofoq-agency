import { detectLanguage, resolveLocale } from "@/lib/ai/language";
import { NotFoundError } from "@/lib/core/errors";
import type { ConversationRow, ConversationWithCustomer, Locale, MessageRow, MessageSender } from "@/lib/domain/types";
import {
  createMessage,
  ensureWebConversation,
  findConversationById,
  incrementUnread,
  listConversations,
  listMessages,
  markConversationRead,
  updateConversation,
} from "@/lib/repositories/messaging.repo";

import { logActivity } from "./activity.service";
import { notifyUsers } from "./notifications.service";

/**
 * Unified conversation layer.
 *
 * Every channel (web chat today; email and WhatsApp later) writes into the same
 * tables and the same client file, and each message keeps its `channel` and its
 * origin so the agency can always tell where a conversation happened.
 */
export interface AppendMessageInput {
  conversationId: string;
  senderType: MessageSender;
  body: string;
  senderUserId?: string | null;
  senderLabel?: string | null;
  language?: string | null;
  meta?: unknown;
  /** Marks the other side's unread counter as increased. */
  isDemo?: number;
}

export async function appendMessage(input: AppendMessageInput): Promise<MessageRow> {
  const conversation = await findConversationById(input.conversationId);
  if (!conversation) throw new NotFoundError("Conversation not found");

  const language = input.language ?? detectLanguage(input.body);
  const message = await createMessage({
    conversation_id: input.conversationId,
    sender_type: input.senderType,
    sender_user_id: input.senderUserId ?? null,
    sender_label: input.senderLabel ?? null,
    body: input.body,
    language,
    meta: input.meta,
    is_demo: input.isDemo,
  });

  // Client messages raise the staff counter; anything else raises the client's.
  const side = input.senderType === "CLIENT" ? "staff" : "client";
  await incrementUnread(input.conversationId, side);

  return message;
}

export async function getOrCreateClientConversation(customerId: string): Promise<ConversationRow> {
  return ensureWebConversation(customerId);
}

export async function clientConversationHistory(
  customerId: string,
  options: { limit?: number } = {},
): Promise<{ conversation: ConversationRow; messages: MessageRow[] }> {
  const conversation = await ensureWebConversation(customerId);
  const messages = await listMessages(conversation.id, { limit: options.limit ?? 50 });
  return { conversation, messages };
}

export async function markReadForClient(conversationId: string, customerId: string): Promise<void> {
  const conversation = await findConversationById(conversationId);
  if (!conversation || conversation.customer_id !== customerId) {
    throw new NotFoundError("Conversation not found");
  }
  await markConversationRead(conversationId, "client");
}

export async function markReadForStaff(conversationId: string, userId: string): Promise<void> {
  await markConversationRead(conversationId, "staff");
  await logActivity({
    actor_type: "USER",
    actor_user_id: userId,
    action: "conversation.read",
    entity_type: "conversation",
    entity_id: conversationId,
    summary: "قراءة المحادثة من فريق الوكالة",
    summary_en: "Conversation read by staff",
  });
}

/** Staff reply: appears in the client's portal and the unified inbox. */
export async function staffReply(
  conversationId: string,
  userId: string,
  userName: string,
  body: string,
  options: { asAgentKey?: string | null } = {},
): Promise<MessageRow> {
  const conversation = await findConversationById(conversationId);
  if (!conversation) throw new NotFoundError("Conversation not found");

  const message = await appendMessage({
    conversationId,
    senderType: options.asAgentKey ? "AGENT" : "STAFF",
    senderUserId: userId,
    senderLabel: options.asAgentKey ?? userName,
    body,
    language: detectLanguage(body),
  });

  // Notify the client in-app and by email (never the other way round).
  const { findCustomerById } = await import("@/lib/repositories/customers.repo");
  const customer = await findCustomerById(conversation.customer_id);
  if (customer?.user_id) {
    await notifyUsers(
      [
        {
          id: customer.user_id,
          email: customer.email ?? "",
          name: customer.contact_name,
          locale: customer.locale,
        },
      ],
      {
        subject:
          customer.locale === "ar" ? "رسالة جديدة من فريق أفق" : "New message from the Ofoq team",
        body,
        email: true,
        inApp: true,
      },
    );
  }

  await updateConversation(conversationId, { status: "OPEN" });

  await logActivity({
    actor_type: "USER",
    actor_user_id: userId,
    action: "conversation.staff_reply",
    entity_type: "conversation",
    entity_id: conversationId,
    customer_id: conversation.customer_id,
    summary: "Staff replied to a client conversation",
  });

  return message;
}

export async function listInbox(
  filter: {
    channel?: ConversationRow["channel"];
    status?: ConversationRow["status"][];
    unreadOnly?: boolean;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ rows: ConversationWithCustomer[]; total: number }> {
  return listConversations({
    channel: filter.channel,
    status: filter.status,
    unreadForStaff: filter.unreadOnly,
    limit: filter.limit,
    offset: filter.offset,
  });
}

export async function conversationMessages(conversationId: string, limit = 50): Promise<MessageRow[]> {
  return listMessages(conversationId, { limit });
}

export async function closeConversation(conversationId: string, userId: string): Promise<void> {
  await updateConversation(conversationId, { status: "CLOSED" });
  await logActivity({
    actor_type: "USER",
    actor_user_id: userId,
    action: "conversation.closed",
    entity_type: "conversation",
    entity_id: conversationId,
    summary: "إغلاق المحادثة",
    summary_en: "Conversation closed",
  });
}

export function messageLanguage(message: MessageRow, fallback: Locale): Locale {
  return resolveLocale(message.body, fallback);
}
