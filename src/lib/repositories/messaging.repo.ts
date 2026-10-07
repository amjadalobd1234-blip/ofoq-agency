import { getDb } from "@/lib/db";
import type { DbDriver } from "@/lib/db/types";
import type {
  Channel,
  ConversationRow,
  ConversationStatus,
  ConversationWithCustomer,
  MessageRow,
  MessageSender,
  NotificationRow,
  OutboxEmailRow,
} from "@/lib/domain/types";
import { nowIso } from "@/lib/core/date";

import { clean, findRowById, insertRow, updateRow } from "./base";

/* ------------------------------------------------------------ conversations */

export async function createConversation(
  data: Partial<ConversationRow> & { customer_id: string },
  db?: DbDriver,
): Promise<ConversationRow> {
  const timestamp = nowIso();
  const row: ConversationRow = {
    id: data.id ?? crypto.randomUUID(),
    customer_id: data.customer_id,
    channel: data.channel ?? "WEB",
    subject: data.subject ?? null,
    status: data.status ?? "OPEN",
    assigned_to_user_id: data.assigned_to_user_id ?? null,
    external_ref: data.external_ref ?? null,
    unread_for_client: data.unread_for_client ?? 0,
    unread_for_staff: data.unread_for_staff ?? 0,
    last_message_at: data.last_message_at ?? null,
    is_demo: data.is_demo ?? 0,
    created_at: timestamp,
    updated_at: timestamp,
  };
  await insertRow("conversations", row, db);
  return row;
}

export async function updateConversation(
  id: string,
  data: Partial<ConversationRow>,
  db?: DbDriver,
): Promise<void> {
  const driver = db ?? (await getDb());
  await updateRow("conversations", id, { ...clean(data), updated_at: nowIso() }, driver);
}

export async function findConversationById(
  id: string,
  db?: DbDriver,
): Promise<ConversationWithCustomer | undefined> {
  const driver = db ?? (await getDb());
  return driver.get<ConversationWithCustomer>(
    `SELECT v.*, c.contact_name AS customer_name
     FROM conversations v JOIN customers c ON c.id = v.customer_id WHERE v.id = ?`,
    [id],
  );
}

/** Returns the customer's open web conversation, creating one when missing. */
export async function ensureWebConversation(customerId: string, db?: DbDriver): Promise<ConversationRow> {
  const driver = db ?? (await getDb());
  const existing = await driver.get<ConversationRow>(
    `SELECT * FROM conversations WHERE customer_id = ? AND channel = 'WEB' AND status <> 'CLOSED'
     ORDER BY created_at DESC LIMIT 1`,
    [customerId],
  );
  if (existing) return existing;
  return createConversation({ customer_id: customerId, channel: "WEB", subject: null }, driver);
}

export async function listConversations(
  filter: {
    customerId?: string;
    channel?: Channel;
    status?: ConversationStatus[];
    unreadForStaff?: boolean;
    limit?: number;
    offset?: number;
  } = {},
  db?: DbDriver,
): Promise<{ rows: ConversationWithCustomer[]; total: number }> {
  const driver = db ?? (await getDb());
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (filter.customerId) {
    clauses.push("v.customer_id = ?");
    params.push(filter.customerId);
  }
  if (filter.channel) {
    clauses.push("v.channel = ?");
    params.push(filter.channel);
  }
  if (filter.status?.length) {
    clauses.push(`v.status IN (${filter.status.map(() => "?").join(", ")})`);
    params.push(...filter.status);
  }
  if (filter.unreadForStaff) clauses.push("v.unread_for_staff > 0");

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const totalRow = await driver.get<{ total: number }>(
    `SELECT COUNT(*) AS total FROM conversations v ${where}`,
    params,
  );
  const rows = await driver.query<ConversationWithCustomer>(
    `SELECT v.*, c.contact_name AS customer_name
     FROM conversations v JOIN customers c ON c.id = v.customer_id
     ${where}
     ORDER BY COALESCE(v.last_message_at, v.created_at) DESC
     LIMIT ? OFFSET ?`,
    [...params, filter.limit ?? 50, filter.offset ?? 0],
  );
  return { rows, total: Number(totalRow?.total ?? 0) };
}

export async function incrementUnread(
  conversationId: string,
  side: "client" | "staff",
  db?: DbDriver,
): Promise<void> {
  const driver = db ?? (await getDb());
  const column = side === "client" ? "unread_for_client" : "unread_for_staff";
  await driver.run(
    `UPDATE conversations SET ${column} = ${column} + 1, last_message_at = ?, updated_at = ? WHERE id = ?`,
    [nowIso(), nowIso(), conversationId],
  );
}

export async function markConversationRead(
  conversationId: string,
  side: "client" | "staff",
  db?: DbDriver,
): Promise<void> {
  const driver = db ?? (await getDb());
  const column = side === "client" ? "unread_for_client" : "unread_for_staff";
  await driver.run(`UPDATE conversations SET ${column} = 0 WHERE id = ?`, [conversationId]);
}

/* ----------------------------------------------------------------- messages */

export async function createMessage(
  data: {
    conversation_id: string;
    sender_type: MessageSender;
    body: string;
    sender_user_id?: string | null;
    sender_label?: string | null;
    language?: string | null;
    translated_body?: string | null;
    translated_language?: string | null;
    meta?: unknown;
    is_demo?: number;
  },
  db?: DbDriver,
): Promise<MessageRow> {
  const row: MessageRow = {
    id: crypto.randomUUID(),
    conversation_id: data.conversation_id,
    sender_type: data.sender_type,
    sender_user_id: data.sender_user_id ?? null,
    sender_label: data.sender_label ?? null,
    body: data.body,
    language: data.language ?? null,
    translated_body: data.translated_body ?? null,
    translated_language: data.translated_language ?? null,
    meta: data.meta ? JSON.stringify(data.meta) : null,
    created_at: nowIso(),
    read_at: null,
    is_demo: data.is_demo ?? 0,
  };
  await insertRow("messages", row, db);
  return row;
}

export async function listMessages(
  conversationId: string,
  options: { limit?: number; beforeIso?: string } = {},
  db?: DbDriver,
): Promise<MessageRow[]> {
  const driver = db ?? (await getDb());
  const params: (string | number)[] = [conversationId];
  let clause = "";
  if (options.beforeIso) {
    clause = "AND created_at < ?";
    params.push(options.beforeIso);
  }
  const rows = await driver.query<MessageRow>(
    `SELECT * FROM messages WHERE conversation_id = ? ${clause} ORDER BY created_at DESC LIMIT ?`,
    [...params, options.limit ?? 50],
  );
  return rows.reverse();
}

export async function countMessagesForCustomer(customerId: string, db?: DbDriver): Promise<number> {
  const driver = db ?? (await getDb());
  const row = await driver.get<{ total: number }>(
    `SELECT COUNT(*) AS total FROM messages m
     JOIN conversations v ON v.id = m.conversation_id WHERE v.customer_id = ?`,
    [customerId],
  );
  return Number(row?.total ?? 0);
}

/* ------------------------------------------------- notifications & outbox -- */

export async function createNotification(
  data: Partial<NotificationRow> & { user_id: string; channel: NotificationRow["channel"] },
  db?: DbDriver,
): Promise<NotificationRow> {
  const row: NotificationRow = {
    id: data.id ?? crypto.randomUUID(),
    user_id: data.user_id,
    alert_id: data.alert_id ?? null,
    channel: data.channel,
    subject: data.subject ?? null,
    body: data.body ?? null,
    status: data.status ?? "QUEUED",
    error: null,
    sent_at: data.sent_at ?? null,
    read_at: data.read_at ?? null,
    created_at: nowIso(),
  };
  await insertRow("notifications", row, db);
  return row;
}

export async function updateNotification(
  id: string,
  data: Partial<NotificationRow>,
  db?: DbDriver,
): Promise<void> {
  const driver = db ?? (await getDb());
  await updateRow("notifications", id, clean(data), driver);
}

export async function listNotifications(
  userId: string,
  options: { unreadOnly?: boolean; limit?: number } = {},
  db?: DbDriver,
): Promise<NotificationRow[]> {
  const driver = db ?? (await getDb());
  const clause = options.unreadOnly ? "AND status <> 'READ'" : "";
  return driver.query<NotificationRow>(
    `SELECT * FROM notifications WHERE user_id = ? ${clause} ORDER BY created_at DESC LIMIT ?`,
    [userId, options.limit ?? 30],
  );
}

export async function markAllNotificationsRead(userId: string, db?: DbDriver): Promise<void> {
  const driver = db ?? (await getDb());
  await driver.run("UPDATE notifications SET status = 'READ', read_at = ? WHERE user_id = ? AND status <> 'READ'", [
    nowIso(),
    userId,
  ]);
}

export async function countUnreadNotifications(userId: string, db?: DbDriver): Promise<number> {
  const driver = db ?? (await getDb());
  const row = await driver.get<{ total: number }>(
    "SELECT COUNT(*) AS total FROM notifications WHERE user_id = ? AND status <> 'READ'",
    [userId],
  );
  return Number(row?.total ?? 0);
}

export async function queueEmail(
  data: {
    to_email: string;
    subject: string;
    text?: string;
    html?: string;
    template?: string;
    to_user_id?: string | null;
    provider?: string;
    meta?: unknown;
  },
  db?: DbDriver,
): Promise<OutboxEmailRow> {
  const row: OutboxEmailRow = {
    id: crypto.randomUUID(),
    to_email: data.to_email,
    to_user_id: data.to_user_id ?? null,
    subject: data.subject,
    text: data.text ?? null,
    html: data.html ?? null,
    template: data.template ?? null,
    status: "QUEUED",
    provider: data.provider ?? "console",
    attempts: 0,
    error: null,
    meta: data.meta ? JSON.stringify(data.meta) : null,
    sent_at: null,
    created_at: nowIso(),
  };
  await insertRow("outbox_emails", row, db);
  return row;
}

export async function markEmailSent(id: string, provider: string, db?: DbDriver): Promise<void> {
  const driver = db ?? (await getDb());
  await driver.run(
    "UPDATE outbox_emails SET status = 'SENT', provider = ?, sent_at = ?, attempts = attempts + 1, error = NULL WHERE id = ?",
    [provider, nowIso(), id],
  );
}

export async function markEmailFailed(id: string, error: string, db?: DbDriver): Promise<void> {
  const driver = db ?? (await getDb());
  await driver.run(
    "UPDATE outbox_emails SET status = 'FAILED', attempts = attempts + 1, error = ? WHERE id = ?",
    [error.slice(0, 500), id],
  );
}

export async function listQueuedEmails(limit = 25, db?: DbDriver): Promise<OutboxEmailRow[]> {
  const driver = db ?? (await getDb());
  return driver.query<OutboxEmailRow>(
    "SELECT * FROM outbox_emails WHERE status = 'QUEUED' ORDER BY created_at LIMIT ?",
    [limit],
  );
}
