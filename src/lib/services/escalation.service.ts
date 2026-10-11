/**
 * Escalation service — the side effects behind a human handoff.
 *
 * `escalation-agent.ts` decides *whether* the team must be involved; this module
 * makes it real, in this order:
 *
 *   1. `ofoq_client_escalate` (SECURITY DEFINER) inserts the `alerts` row,
 *      flips the conversation to `PENDING`, writes the in-app + email
 *      `notifications` for every active OWNER/PARTNER and logs the activity.
 *      Direct table writes are revoked for the client portal, so the RPC is the
 *      only path — and it re-checks that the caller may act on the conversation
 *      (the owner of it, or any active OWNER/PARTNER).
 *   2. The owner is emailed with the `human_escalation` template (Resend when
 *      `RESEND_API_KEY` is set, otherwise the message is rendered and logged).
 *   3. `ofoq_escalation_email_result` records the delivery outcome on the
 *      notification rows, so a failed email is visible instead of silent.
 *
 * Nothing here throws. The caller receives an honest outcome and tells the
 * client only what actually happened.
 */
import {
  detectEscalation,
  escalationAlertPayload,
  handoffNotice,
  summariseConversation,
  type EscalationCategory,
  type EscalationDecision,
  type EscalationSeverity,
  type EscalationTurn,
} from "@/lib/agents/escalation-agent";
import { getEnv } from "@/lib/config/env";
import { logger } from "@/lib/core/logger";
import type { Locale } from "@/lib/domain/types";
import { appUrl, humanEscalationTemplate, isValidEmail, sendTemplateEmail } from "@/lib/email/email-service";

/**
 * Fallback owner address.
 *
 * The agency owner asked to receive every human handoff even before the
 * platform's `users` table holds an OWNER row, so the address is kept as a
 * documented default. Set `OWNER_EMAIL` (comma separated) to override it.
 */
export const DEFAULT_OWNER_EMAIL = "amjadalobd1234@gmail.com";

/** Minimal shape this service needs, satisfied by the Supabase server client. */
export interface EscalationRpcClient {
  rpc(
    functionName: string,
    args?: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
}

export interface EscalationEmailOutcome {
  attempted: boolean;
  delivered: boolean;
  provider: "resend" | "console";
  recipients: string[];
  error?: string;
}

export interface EscalationOutcome {
  /** True when an alert row now exists for this conversation. */
  escalated: boolean;
  /** True when this call created (or re-opened) the alert row. */
  created: boolean;
  alertId: string | null;
  category: EscalationCategory | null;
  severity: EscalationSeverity | null;
  conversationStatus: string | null;
  email: EscalationEmailOutcome;
  /** Client-facing line to append to the assistant reply ("" when not needed). */
  notice: string;
  error?: string;
}

interface EscalateRpcResult {
  alertId?: string | null;
  created?: boolean | null;
  conversationStatus?: string | null;
  clientName?: string | null;
  clientEmail?: string | null;
  staff?: Array<{ id?: string | null; email?: string | null; name?: string | null }> | null;
  /** Added by migration 0004: who raised it, as the database saw them. */
  identity?: Record<string, unknown> | null;
}

/**
 * Who is raising the escalation.
 *
 * Passed in by the route (which already knows the session) purely so a failure
 * can be diagnosed from the server log alone: an escalation that is refused for
 * an OWNER with no `customers` row looks exactly like a wrong conversation id
 * without it.
 */
export interface EscalationCallerContext {
  userId?: string | null;
  /** OWNER | PARTNER | CLIENT, as far as the profile read allowed. */
  role?: string | null;
  customerId?: string | null;
}

export interface RaiseClientEscalationInput {
  client: EscalationRpcClient;
  conversationId: string;
  latestMessage: string;
  history?: EscalationTurn[];
  locale?: Locale;
  /** Reuse a decision already made by the caller (the chat route). */
  decision?: EscalationDecision;
  /** Set to false in tests or where email must not leave the process. */
  sendOwnerEmail?: boolean;
  /** Session details used for the diagnostic log when the write fails. */
  context?: EscalationCallerContext;
}

/**
 * Turns a Postgres error into the next thing to look at.
 *
 * The portal lives behind SECURITY DEFINER RPCs, so the same message can mean
 * "the migration was never applied", "this account has no client record", or
 * "the alerts table is from an older schema". The hint is written to the log
 * next to the raw error, never shown to the client.
 */
export function describeEscalationError(
  code?: string | null,
  message?: string | null,
): string {
  const text = `${code ?? ""} ${message ?? ""}`;
  if (/PGRST202|42883/.test(text)) {
    const missing = /public\.([a-z_]+)/i.exec(message ?? "")?.[1];
    return `the ${missing ?? "escalation"} RPC is not installed — apply docs/setup/supabase-setup.sql (it bundles db/migrations/supabase/0004_escalation_owner_support.sql) in the SQL Editor`;
  }
  if (/\b42P01\b/.test(text) || /relation .*alerts.* does not exist/i.test(text)) {
    return "the public.alerts table does not exist — the portal schema was never fully applied";
  }
  if (/\b42703\b/.test(text) || /column .*(dedupe_key|target_role).* does not exist/i.test(text)) {
    return "public.alerts is missing a column (dedupe_key/target_role) — the deployed table predates this migration, re-run docs/setup/supabase-setup.sql";
  }
  if (/\b23502\b/.test(text)) {
    return "a NOT NULL column rejected the alert row — alerts.customer_id must stay nullable";
  }
  if (/\b42501\b/.test(text) || /Not allowed to escalate/i.test(text)) {
    return "the caller may not escalate this conversation: the account has no customers row, or the conversation belongs to somebody else (owners/partners are always allowed after 0004)";
  }
  if (/\b28000\b/.test(text)) {
    return "the session is not an ACTIVE platform account";
  }
  return "unclassified escalation failure — run GET /api/debug/escalation while signed in to see the exact state";
}

/** Raises the escalation. Always resolves with an honest outcome. */
export async function raiseClientEscalation(
  input: RaiseClientEscalationInput,
): Promise<EscalationOutcome> {
  const locale: Locale = input.locale === "en" ? "en" : "ar";
  const decision =
    input.decision ??
    detectEscalation({
      latestMessage: input.latestMessage,
      history: input.history ?? [],
    });

  const email: EscalationEmailOutcome = {
    attempted: false,
    delivered: false,
    provider: "console",
    recipients: [],
  };
  const notRaised: EscalationOutcome = {
    escalated: false,
    created: false,
    alertId: null,
    category: decision.category,
    severity: decision.severity,
    conversationStatus: null,
    email,
    notice: handoffNotice(locale, "failed"),
  };

  if (!decision.escalate || !decision.category || !decision.severity) {
    return { ...notRaised, notice: "" };
  }

  const summary = summariseConversation({
    history: input.history ?? [],
    latestMessage: input.latestMessage,
    locale,
  });
  const payload = escalationAlertPayload(decision, summary);

  // Everything needed to answer "why was this handoff not recorded?" from the
  // log alone. `customerId` is the one that mattered for owners: no row in
  // `customers` used to abort the RPC before the alert was written.
  const diagnostics = {
    userId: input.context?.userId ?? null,
    role: input.context?.role ?? null,
    customerId: input.context?.customerId ?? null,
    conversationId: input.conversationId,
    category: payload.category,
    severity: payload.severity,
  };

  let result: EscalateRpcResult;
  try {
    const response = await input.client.rpc("ofoq_client_escalate", {
      p_conversation_id: input.conversationId,
      p_category: payload.category,
      p_severity: payload.severity,
      p_title_ar: payload.title_ar,
      p_title_en: payload.title_en,
      p_body_ar: payload.body_ar,
      p_body_en: payload.body_en,
      p_reason: decision.reasonEn,
      p_signals: payload.meta.signals.join(","),
    });
    if (response.error || !response.data) {
      // Note: the context must never carry a `message` key — the logger spreads
      // it after its own message and would erase the line's meaning.
      logger.error("[escalation] alert row was not written", {
        ...diagnostics,
        code: response.error?.code ?? null,
        error: response.error?.message ?? "empty RPC result",
        hint: describeEscalationError(response.error?.code, response.error?.message),
      });
      return { ...notRaised, error: response.error?.message ?? "escalation_rpc_failed" };
    }
    result = response.data as EscalateRpcResult;
  } catch (error) {
    logger.error("[escalation] RPC call failed", {
      ...diagnostics,
      error: error instanceof Error ? error.message : String(error),
      hint: describeEscalationError(null, error instanceof Error ? error.message : String(error)),
    });
    return { ...notRaised, error: error instanceof Error ? error.message : String(error) };
  }

  const alertId = typeof result.alertId === "string" ? result.alertId : null;
  if (!alertId) {
    logger.error("[escalation] RPC returned no alert id", {
      ...diagnostics,
      hint: describeEscalationError(null, "no alert id"),
    });
    return { ...notRaised, error: "no_alert_id" };
  }

  const outcome: EscalationOutcome = {
    escalated: true,
    created: Boolean(result.created),
    alertId,
    category: payload.category,
    severity: payload.severity,
    conversationStatus: typeof result.conversationStatus === "string" ? result.conversationStatus : null,
    email,
    notice: handoffNotice(locale, "confirmed"),
  };

  // Email only on a NEW (or re-opened) alert. The RPC deduplicates per
  // conversation, category and day, so a client who keeps typing must not send
  // the owner a message per turn — the open alert is already in /admin.
  if (input.sendOwnerEmail !== false && outcome.created) {
    outcome.email = await notifyOwnerByEmail({
      client: input.client,
      alertId,
      staff: Array.isArray(result.staff) ? result.staff : [],
      clientName: result.clientName ?? "",
      clientEmail: result.clientEmail ?? "",
      conversationId: input.conversationId,
      summaryAr: summary.ar,
      locale,
    });
    // A missing email never hides the alert: the row and the in-app
    // notifications are already written and visible in /admin.
    if (outcome.email.attempted && !outcome.email.delivered) {
      logger.warn("Escalation alert raised but the owner email was not delivered", {
        alertId,
        provider: outcome.email.provider,
        error: outcome.email.error,
      });
    }
  }

  logger.info("Client conversation escalated to the human team", {
    ...diagnostics,
    alertId,
    created: outcome.created,
    emailDelivered: outcome.email.delivered,
    // What the database saw — the fastest way to confirm an owner really is
    // allowed to escalate now, not only what the route believed.
    identity: identityOf(result),
  });

  return outcome;
}

/** The `identity` block the RPC returns, kept only when it is an object. */
function identityOf(result: EscalateRpcResult): Record<string, unknown> | null {
  const identity = (result as { identity?: unknown }).identity;
  if (identity && typeof identity === "object" && !Array.isArray(identity)) {
    return identity as Record<string, unknown>;
  }
  return null;
}

/**
 * Runs `ofoq_escalation_diagnostics` — the SQL-side answer to "why did the
 * handoff fail?" — and returns its payload (or the reason it could not run).
 *
 * Used by GET /api/debug/escalation and by section 8 of /debug. Never throws:
 * a project where the migration is missing is exactly the case worth reporting.
 */
export async function fetchEscalationDiagnostics(
  client: EscalationRpcClient,
  conversationId?: string | null,
): Promise<{ ok: boolean; data?: unknown; error?: string; hint?: string }> {
  try {
    const response = await client.rpc(
      "ofoq_escalation_diagnostics",
      conversationId ? { p_conversation_id: conversationId } : {},
    );
    if (response.error) {
      const hint = describeEscalationError(response.error.code, response.error.message);
      logger.error("[escalation] diagnostics RPC failed", {
        code: response.error.code ?? null,
        error: response.error.message,
        hint,
      });
      return { ok: false, error: response.error.message, hint };
    }
    return { ok: true, data: response.data };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message, hint: describeEscalationError(null, message) };
  }
}

/** A PostgREST error, kept whole: code, message, details and hint. */
export interface PostgrestErrorLike {
  code?: string | null;
  message?: string | null;
  details?: string | null;
  hint?: string | null;
}

/** Minimal shape the probe needs, satisfied by the Supabase server client. */
export interface AlertProbeClient {
  from(table: "alerts"): {
    insert(values: Record<string, unknown>): PromiseLike<{ error: PostgrestErrorLike | null }>;
    delete(): { eq(column: string, value: string): PromiseLike<{ error: PostgrestErrorLike | null }> };
  };
}

export interface AlertInsertProbe {
  /** The id the probe row was written with (also the id it is deleted by). */
  probeId: string;
  insert: { ok: boolean; error: PostgrestErrorLike | null };
  /** Only attempted when the INSERT succeeded. */
  cleanup: { attempted: boolean; ok: boolean; error: PostgrestErrorLike | null };
  /** One line on what the failure most likely means. Null when nothing failed. */
  hint: string | null;
}

function toErrorLike(error: unknown): PostgrestErrorLike {
  if (error && typeof error === "object") {
    const candidate = error as PostgrestErrorLike;
    return {
      code: candidate.code ?? null,
      message: candidate.message ?? String(error),
      details: candidate.details ?? null,
      hint: candidate.hint ?? null,
    };
  }
  return { code: null, message: String(error), details: null, hint: null };
}

/**
 * Explains a direct INSERT failure on `public.alerts`.
 *
 * Migration 0001 revokes every table privilege from `authenticated`, so a
 * direct INSERT is refused with 42501 before RLS is even evaluated. Migration
 * 0004's policy only matters once a GRANT exists. The app therefore writes
 * alerts through `ofoq_client_escalate` by design, and a direct INSERT is
 * expected to fail.
 */
export function describeAlertInsertError(error: PostgrestErrorLike | null): string | null {
  if (!error) return null;
  const text = `${error.code ?? ""} ${error.message ?? ""} ${error.details ?? ""}`;
  if (/\b42501\b/.test(text) && /row-level security/i.test(text)) {
    return "RLS rejected the row: the alerts_insert_authenticated policy (0004) requires entity_type='conversation', target_role='ANY_STAFF' and severity URGENT/IMPORTANT.";
  }
  if (/\b42501\b/.test(text) || /permission denied/i.test(text)) {
    return "permission denied on public.alerts: the authenticated role has no INSERT grant (0001 revokes all table privileges). This is expected for a direct INSERT; alerts are written only by the ofoq_client_escalate RPC.";
  }
  if (/\b42P01\b/.test(text) || /relation .*alerts.* does not exist/i.test(text)) {
    return "the public.alerts table does not exist — the schema was never fully applied.";
  }
  if (/\b23502\b/.test(text)) {
    return "a NOT NULL column rejected the probe row — compare public.alerts with docs/setup/supabase-setup.sql.";
  }
  if (/\b23505\b/.test(text)) {
    return "a unique constraint rejected the probe row (id or dedupe_key already exists).";
  }
  if (/\b23514\b/.test(text)) {
    return "a CHECK constraint rejected the probe row (severity, status or target_role value).";
  }
  return "unclassified INSERT failure — the full error is in the response; compare it with the table definition.";
}

/**
 * Writes one real row into `public.alerts` through the caller's own session,
 * then deletes it. Used by GET /api/debug/escalation?insertTest=1 to find out,
 * from the actual database, whether a direct INSERT is possible and, if not,
 * exactly why.
 *
 * The probe row is clearly labelled and uses category `DEBUG_PROBE`, which no
 * dashboard counter groups as a lead. It is removed right after the INSERT.
 * Nothing throws: every outcome is returned for the caller to show.
 */
export async function probeAlertInsert(
  client: AlertProbeClient,
  conversationId?: string | null,
): Promise<AlertInsertProbe> {
  const probeId = `debug-probe-${globalThis.crypto.randomUUID()}`;
  const now = new Date().toISOString();

  let insertError: PostgrestErrorLike | null = null;
  try {
    const response = await client.from("alerts").insert({
      id: probeId,
      severity: "IMPORTANT",
      category: "DEBUG_PROBE",
      title_ar: "[اختبار تشخيص] يمكن حذفه",
      title_en: "[debug probe] safe to delete",
      body_ar: null,
      body_en: "Written by GET /api/debug/escalation?insertTest=1 and deleted right after.",
      entity_type: "conversation",
      entity_id: conversationId ?? null,
      target_role: "ANY_STAFF",
      status: "NEW",
      dedupe_key: null,
      meta: JSON.stringify({ source: "debug-probe" }),
      is_demo: 0,
      created_at: now,
      updated_at: now,
    });
    insertError = response.error ? toErrorLike(response.error) : null;
  } catch (error) {
    insertError = toErrorLike(error);
  }

  if (insertError) {
    logger.error("[escalation] debug INSERT probe failed", {
      probeId,
      code: insertError.code ?? null,
      error: insertError.message ?? null,
      details: insertError.details ?? null,
      hint: insertError.hint ?? null,
      explanation: describeAlertInsertError(insertError),
    });
    return {
      probeId,
      insert: { ok: false, error: insertError },
      cleanup: { attempted: false, ok: false, error: null },
      hint: describeAlertInsertError(insertError),
    };
  }

  let cleanupError: PostgrestErrorLike | null = null;
  try {
    const response = await client.from("alerts").delete().eq("id", probeId);
    cleanupError = response.error ? toErrorLike(response.error) : null;
  } catch (error) {
    cleanupError = toErrorLike(error);
  }

  if (cleanupError) {
    logger.error("[escalation] debug INSERT probe row could not be deleted", {
      probeId,
      code: cleanupError.code ?? null,
      error: cleanupError.message ?? null,
    });
  }

  return {
    probeId,
    insert: { ok: true, error: null },
    cleanup: { attempted: true, ok: !cleanupError, error: cleanupError },
    hint: cleanupError
      ? `the INSERT worked but the probe row ${probeId} was NOT deleted — remove it manually in the Table Editor.`
      : null,
  };
}

/** Every address that must hear about a handoff: configured owner + staff rows. */
export function escalationRecipients(staffEmails: Array<string | null | undefined>): string[] {
  const configured = getEnv()
    .email.ownerEmails.length
    ? getEnv().email.ownerEmails
    : [DEFAULT_OWNER_EMAIL];
  const unique = new Set<string>();
  for (const value of [...configured, ...staffEmails]) {
    const address = (value ?? "").trim().toLowerCase();
    if (address && isValidEmail(address)) unique.add(address);
  }
  return [...unique];
}

async function notifyOwnerByEmail(input: {
  client: EscalationRpcClient;
  alertId: string;
  staff: Array<{ id?: string | null; email?: string | null; name?: string | null }>;
  clientName: string;
  clientEmail: string;
  conversationId: string;
  summaryAr: string;
  locale: Locale;
}): Promise<EscalationEmailOutcome> {
  const recipients = escalationRecipients(input.staff.map((member) => member.email ?? null));
  const notSent: EscalationEmailOutcome = {
    attempted: false,
    delivered: false,
    provider: "console",
    recipients,
  };
  if (recipients.length === 0) return notSent;

  const ar = input.locale !== "en";
  const message = [
    input.summaryAr,
    "",
    `${ar ? "المحادثة" : "Conversation"}: ${input.conversationId}`,
    `${ar ? "لوحة المراقبة" : "Control room"}: ${appUrl()}/admin`,
  ].join("\n");

  const template = humanEscalationTemplate(input.clientName, message, {
    locale: input.locale,
    clientEmail: input.clientEmail || undefined,
    conversationId: input.conversationId,
  });

  const delivery = await sendTemplateEmail(recipients, template);
  const outcome: EscalationEmailOutcome = {
    attempted: true,
    delivered: delivery.delivered,
    provider: delivery.provider,
    recipients,
    error: delivery.error,
  };

  // Best effort: the alert already exists, so a bookkeeping failure here must
  // not change what the client is told.
  try {
    await input.client.rpc("ofoq_escalation_email_result", {
      p_alert_id: input.alertId,
      p_delivered: delivery.delivered,
      p_provider: delivery.provider,
      p_error: delivery.error ?? null,
    });
  } catch (error) {
    logger.warn("Could not record the escalation email outcome", {
      alertId: input.alertId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return outcome;
}
