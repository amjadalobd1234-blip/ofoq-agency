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
 *      only path — and it re-checks that the caller owns the conversation.
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
      logger.error("Escalation alert could not be recorded", {
        conversationId: input.conversationId,
        code: response.error?.code,
        message: response.error?.message,
      });
      return { ...notRaised, error: response.error?.message ?? "escalation_rpc_failed" };
    }
    result = response.data as EscalateRpcResult;
  } catch (error) {
    logger.error("Escalation RPC call failed", {
      conversationId: input.conversationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ...notRaised, error: error instanceof Error ? error.message : String(error) };
  }

  const alertId = typeof result.alertId === "string" ? result.alertId : null;
  if (!alertId) {
    logger.error("Escalation RPC returned no alert id", { conversationId: input.conversationId });
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
    alertId,
    created: outcome.created,
    category: payload.category,
    severity: payload.severity,
    conversationId: input.conversationId,
    emailDelivered: outcome.email.delivered,
  });

  return outcome;
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
