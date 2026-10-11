import { detectLanguage, resolveLocale, t } from "@/lib/ai/language";
import { logger } from "@/lib/core/logger";
import { getEnv } from "@/lib/config/env";
import type { ConversationRow, CustomerRow, Locale, MessageRow } from "@/lib/domain/types";
import { findCustomerByUserId, findCustomerById } from "@/lib/repositories/customers.repo";
import {
  appendMessage,
  clientConversationHistory,
  getOrCreateClientConversation,
  markReadForClient,
} from "@/lib/services/conversations.service";
import { raiseAlert } from "@/lib/services/alerts.service";
import { notifyUsers } from "@/lib/services/notifications.service";
import { listStaffUsers } from "@/lib/repositories/identity.repo";
import { logActivity } from "@/lib/services/activity.service";
import { analyseSatisfaction } from "@/lib/agents/specialists/satisfaction.agent";
import { detectEscalation } from "@/lib/agents/escalation-agent";
import { handleClientTurn, markJourneyApproved, type AssistantTurnResult } from "@/lib/agents/specialists/orchestrator.agent";
import { loadProfile } from "@/lib/agents/specialists/needs.agent";

/**
 * "مساعد أفق" — the single client-facing assistant.
 *
 * The client never meets individual agents: this service is the only interface.
 * It is always identified as an AI assistant belonging to the agency, detects the
 * client's language automatically, and routes the conversation through the
 * orchestrator agent, which calls the internal specialists as needed.
 */

export const ASSISTANT_DISCLOSURE = {
  ar: "مساعد أفق هو مساعد ذكي تابع لوكالة أفق، ولست شخصًا. يمكنك طلب التواصل مع فريق بشري في أي وقت.",
  en: "The Ofoq assistant is an AI assistant that belongs to the Ofoq agency — not a person. You can ask for a human team member at any time.",
} as const;

export interface AssistantReply {
  conversationId: string;
  message: MessageRow;
  reply: MessageRow;
  quickReplies: string[];
  stage: AssistantTurnResult["stage"];
  language: Locale;
  refs?: AssistantTurnResult["refs"];
  escalated: boolean;
}

/** Entry point used by the portal chat (and later by email/WhatsApp channels). */
export async function sendClientMessage(input: {
  customerId: string;
  body: string;
  userId?: string | null;
  channel?: ConversationRow["channel"];
}): Promise<AssistantReply> {
  const customer = await findCustomerById(input.customerId);
  if (!customer) throw new Error("Customer not found");

  const conversation = await getOrCreateClientConversation(customer.id);
  const language = resolveLocale(input.body, customer.locale);

  const message = await appendMessage({
    conversationId: conversation.id,
    senderType: "CLIENT",
    body: input.body,
    senderUserId: input.userId ?? null,
    language,
  });

  const turn = await handleClientTurn({
    customer,
    message: input.body,
    conversationId: conversation.id,
    actorUserId: input.userId ?? null,
  });

  const reply = await appendMessage({
    conversationId: conversation.id,
    senderType: "ASSISTANT",
    senderLabel: language === "ar" ? "مساعد أفق" : "Ofoq assistant",
    body: turn.reply,
    language,
    meta: {
      stage: turn.stage,
      quickReplies: turn.quickReplies,
      refs: turn.refs ?? null,
      disclosure: ASSISTANT_DISCLOSURE[language],
      internalNote: turn.internalNote ?? null,
    },
  });

  await logActivity({
    actor_type: "AGENT",
    actor_label: "orchestrator",
    action: "assistant.replied",
    entity_type: "conversation",
    entity_id: conversation.id,
    customer_id: customer.id,
    summary: `رد مساعد أفق (${turn.stage})`,
    meta: { language, escalated: turn.escalate ?? false },
  });

  if (turn.escalate) {
    await notifyStaffOfEscalation({
      customer,
      turn,
      replyText: turn.reply,
      conversationId: conversation.id,
      clientMessage: input.body,
    });
  }
  return {
    conversationId: conversation.id,
    message,
    reply,
    quickReplies: turn.quickReplies,
    stage: turn.stage,
    language,
    refs: turn.refs,
    escalated: Boolean(turn.escalate),
  };
}

async function notifyStaffOfEscalation(input: {
  customer: CustomerRow;
  turn: AssistantTurnResult;
  replyText: string;
  conversationId: string;
  clientMessage: string;
}): Promise<void> {
  const { customer, turn } = input;
  // Same taxonomy as the client portal chat: an explicit human request or a
  // complaint is HUMAN_REQUEST/URGENT, anything else keeps its business category.
  const decision = detectEscalation({ latestMessage: input.clientMessage, assistantReply: input.replyText });
  const needsApproval = Boolean(turn.escalationReason?.includes("approval"));
  try {
    const staff = await listStaffUsers();
    await notifyUsers(staff, {
      subject:
        turn.escalationReason?.includes("dissatisfaction") || turn.escalationReason?.includes("unhappy")
          ? `⚠ عميل غير راضٍ: ${customer.contact_name}`
          : `متابعة مطلوبة: ${customer.contact_name}`,
      body:
        `${turn.escalationReason ?? "The assistant escalated this conversation."}\n\n` +
        `Client: ${customer.contact_name}${customer.company_name ? ` (${customer.company_name})` : ""}\n` +
        `Last assistant message: ${input.replyText.slice(0, 400)}`,
      email: true,
      inApp: true,
      meta: { customerId: customer.id, conversationId: input.conversationId },
    });

    await raiseAlert({
      severity: decision.severity ?? (needsApproval ? "IMPORTANT" : "URGENT"),
      category: decision.category ?? (needsApproval ? "sales" : "support"),
      title_ar: "محادثة تحتاج تدخلًا بشريًا",
      title_en: "Conversation needs human attention",
      body_ar: `العميل ${customer.contact_name} — السبب: ${turn.escalationReason ?? "غير محدد"}`,
      body_en: `Client ${customer.contact_name} — reason: ${turn.escalationReason ?? "unspecified"}`,
      entity_type: "conversation",
      entity_id: input.conversationId,
      customer_id: customer.id,
      dedupe_key: `escalation:${input.conversationId}:${new Date().toISOString().slice(0, 10)}`,
      notify: false,
    });
  } catch (error) {
    logger.error("Failed to notify staff about an escalation", { error });
  }
}

/* ------------------------------------------------------------ portal reads --- */

export interface AssistantBootstrap {
  conversationId: string;
  messages: {
    id: string;
    sender: MessageRow["sender_type"];
    body: string;
    createdAt: string;
    meta: unknown;
  }[];
  greeting: string;
  disclosure: string;
  quickReplies: string[];
  language: Locale;
  /** Onboarding progress shown as "what we still need". */
  discovery: { completeness: number; missing: string[] };
  aiProvider: { available: boolean; reason?: string };
}

/**
 * Loads the conversation for the portal. If the client has never chatted, the
 * first assistant greeting is created here (step 1 of the required flow) — after
 * registration the client lands directly in this conversation, not on a form.
 */
export async function bootstrapAssistant(customerId: string): Promise<AssistantBootstrap> {
  const customer = await findCustomerById(customerId);
  if (!customer) throw new Error("Customer not found");

  const { conversation, messages } = await clientConversationHistory(customer.id, { limit: 60 });
  const language = customer.locale;
  const profile = await loadProfile(customer);
  const aiAvailable = (await import("@/lib/ai/provider")).aiStatus();

  if (messages.length === 0) {
    const greeting = `${t("greeting", language)}\n\n${t("assistantDisclosure", language)}`;
    await appendMessage({
      conversationId: conversation.id,
      senderType: "ASSISTANT",
      senderLabel: language === "ar" ? "مساعد أفق" : "Ofoq assistant",
      body: greeting,
      language,
      meta: { step: "greeting", quickReplies: welcomeQuickReplies(language) },
    });
    const refreshed = await clientConversationHistory(customer.id, { limit: 60 });
    return buildBootstrap(refreshed.conversation, refreshed.messages, customer, profile.completeness, profile.missing, aiAvailable);
  }

  return buildBootstrap(conversation, messages, customer, profile.completeness, profile.missing, aiAvailable);
}

function buildBootstrap(
  conversation: ConversationRow,
  messages: MessageRow[],
  customer: CustomerRow,
  completeness: number,
  missing: string[],
  ai: { available: boolean; reason?: string },
): AssistantBootstrap {
  return {
    conversationId: conversation.id,
    messages: messages.map((message) => ({
      id: message.id,
      sender: message.sender_type,
      body: message.body,
      createdAt: message.created_at,
      meta: message.meta ? safeParse(message.meta) : null,
    })),
    greeting: t("greeting", customer.locale),
    disclosure: ASSISTANT_DISCLOSURE[customer.locale],
    quickReplies: welcomeQuickReplies(customer.locale),
    language: customer.locale,
    discovery: { completeness, missing },
    aiProvider: { available: ai.available, reason: ai.reason },
  };
}

function welcomeQuickReplies(locale: Locale): string[] {
  return locale === "ar"
    ? ["أريد إدارة حسابات التواصل", "أريد إعلانات مدفوعة", "أريد موقعًا إلكترونيًا", "حالة مشاريعي"]
    : ["Social media management", "Paid ads", "I need a website", "My project status"];
}

export async function markTranslated(body: string, target: Locale): Promise<{ language: Locale; text: string }> {
  return { language: target, text: body };
}

export function messageLanguage(message: MessageRow): Locale {
  return message.language === "en" ? "en" : "ar";
}

/** Marks the client side of the conversation as read. */
export async function markAssistantRead(conversationId: string, customerId: string): Promise<void> {
  await markReadForClient(conversationId, customerId);
}

/** Used after an offer is approved from the portal, so the chat reflects reality. */
export async function notifyAssistantOfferApproved(customerId: string, offerCode: string): Promise<void> {
  const customer = await findCustomerById(customerId);
  if (!customer) return;
  const conversation = await getOrCreateClientConversation(customer.id);
  const language = customer.locale;
  await appendMessage({
    conversationId: conversation.id,
    senderType: "ASSISTANT",
    senderLabel: language === "ar" ? "مساعد أفق" : "Ofoq assistant",
    body:
      language === "ar"
        ? `شكرًا لك! ستجد في صفحة الفواتير فاتورة العرض ${offerCode}، وبعد تأكيد الدفع نبدأ التنفيذ وسأتابعك خطوة بخطوة.`
        : `Thank you! Invoice for offer ${offerCode} is now in your Invoices page. Once payment is confirmed we start delivery and I'll keep you updated.`,
    language,
    meta: { step: "offer_approved", offerCode },
  });
  await markJourneyApproved(customer.id);
}

/** Health snapshot for the staff dashboard ("is the assistant healthy?"). */
export async function assistantStatus(): Promise<{
  aiProvider: string;
  aiAvailable: boolean;
  assistantNameAr: string;
  assistantNameEn: string;
  disclosureAr: string;
  disclosureEn: string;
  demoMode: boolean;
}> {
  const { aiStatus } = await import("@/lib/ai/provider");
  const status = aiStatus();
  return {
    aiProvider: status.provider,
    aiAvailable: status.available,
    assistantNameAr: "مساعد أفق",
    assistantNameEn: "Ofoq assistant",
    disclosureAr: ASSISTANT_DISCLOSURE.ar,
    disclosureEn: ASSISTANT_DISCLOSURE.en,
    demoMode: getEnv().seedDemoData,
  };
}

/** Satisfaction context shown to staff next to the conversation. */
export async function satisfactionSnapshot(): Promise<{ average: number | null; count: number; low: number }> {
  const analysis = await analyseSatisfaction("ar");
  return { average: analysis.average, count: analysis.count, low: analysis.lowRatingCount };
}

export async function customerForUser(userId: string): Promise<CustomerRow | undefined> {
  return findCustomerByUserId(userId);
}

export function detectMessageLanguage(body: string, fallback: Locale): Locale {
  return resolveLocale(body, fallback) ?? detectLanguage(body) ?? fallback;
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
