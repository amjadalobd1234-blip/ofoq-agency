import { getEnv } from "@/lib/config/env";
import { logger } from "@/lib/core/logger";
import type { Locale, OutboxEmailRow } from "@/lib/domain/types";
import {
  listQueuedEmails,
  markEmailFailed,
  markEmailSent,
  queueEmail,
} from "@/lib/repositories/messaging.repo";

/**
 * Email.
 *
 * Every message is written to the outbox first, then delivered through the
 * configured provider. With `EMAIL_PROVIDER=console` (the default) the mail is
 * printed to the server log and marked as sent — so the whole flow is testable
 * before an SMTP/Resend account exists. Nothing here invents a sender: without a
 * configured provider the platform simply uses the console transport.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  body: string;
  html?: string | null;
  replyTo?: string | null;
}

export interface BrandContext {
  agencyName: string;
  primary: string;
  accent: string;
}

const DEFAULT_BRAND: BrandContext = { agencyName: "أفق | Ofoq", primary: "#0b1220", accent: "#c8a24a" };

/** Wraps plain text in the shared bilingual, RTL-aware email shell. */
export function renderEmailHtml(message: EmailMessage, locale: Locale = "ar", brand = DEFAULT_BRAND): string {
  const dir = locale === "ar" ? "rtl" : "ltr";
  const align = locale === "ar" ? "right" : "left";
  const body = (message.html ?? escapeHtml(message.body).replace(/\n/g, "<br />")) as string;
  return `<!doctype html>
<html lang="${locale}" dir="${dir}">
  <head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /></head>
  <body style="margin:0;background:#f4f5f7;font-family:system-ui,-apple-system,'Segoe UI',Tahoma,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 0;">
      <tr><td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e6e8ee;">
          <tr>
            <td style="background:${brand.primary};padding:20px 24px;color:#ffffff;">
              <div style="font-size:20px;font-weight:700;letter-spacing:2px;">${escapeHtml(brand.agencyName)}</div>
              <div style="height:3px;width:56px;background:${brand.accent};margin-top:8px;border-radius:2px;"></div>
            </td>
          </tr>
          <tr>
            <td style="padding:24px;color:#1b1f2a;font-size:15px;line-height:1.85;text-align:${align};">
              <h1 style="margin:0 0 12px;font-size:18px;color:${brand.primary};">${escapeHtml(message.subject)}</h1>
              ${body}
            </td>
          </tr>
          <tr>
            <td style="padding:16px 24px;background:#0b1220;color:#c9ccd6;font-size:12px;text-align:${align};">
              ${locale === "ar" ? "هذه رسالة من منصة أفق. لا نطلب بيانات بطاقتك عبر البريد." : "This message comes from the Ofoq platform. We never ask for card details by email."}
            </td>
          </tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Queues a message so it is durable even if the provider call fails. */
export async function enqueueEmail(input: {
  to: string;
  subject: string;
  body: string;
  html?: string | null;
  customerId?: string | null;
  template?: string | null;
  isDemo?: number;
}): Promise<OutboxEmailRow> {
  return queueEmail({
    to_email: input.to,
    subject: input.subject,
    body: input.body,
    html: input.html ?? null,
    provider: getEnv().email.provider,
    customer_id: input.customerId ?? null,
    template: input.template ?? null,
    is_demo: input.isDemo ?? 0,
  });
}

/** Sends (or prints) one message and updates the outbox row. */
export async function deliverEmail(row: OutboxEmailRow): Promise<{ ok: boolean; provider: string; error?: string }> {
  const env = getEnv();

  try {
    if (env.email.provider === "console") {
      logger.info("[email:console] message delivered to the server log", {
        to: row.to_email,
        subject: row.subject,
        preview: row.body.slice(0, 400),
      });
      await markEmailSent(row.id, "console");
      return { ok: true, provider: "console" };
    }

    if (env.email.provider === "resend") {
      if (!env.email.resendApiKey) throw new Error("RESEND_API_KEY is not set");
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.email.resendApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: env.email.fromAddress,
          to: [row.to_email],
          subject: row.subject,
          text: row.body,
          html: row.html ?? undefined,
        }),
      });
      if (!response.ok) throw new Error(`Resend responded ${response.status}`);
      await markEmailSent(row.id, "resend");
      return { ok: true, provider: "resend" };
    }

    if (env.email.provider === "smtp") {
      if (!env.email.smtpHost) throw new Error("SMTP_HOST is not set");
      // nodemailer is an optional dependency: install it only when SMTP is used.
      const nodemailer = await import("nodemailer").catch(() => null);
      if (!nodemailer) {
        throw new Error("nodemailer is not installed. Run `npm i nodemailer` and restart to use EMAIL_PROVIDER=smtp.");
      }
      const transport = nodemailer.createTransport({
        host: env.email.smtpHost,
        port: env.email.smtpPort,
        secure: env.email.smtpSecure,
        auth: env.email.smtpUser ? { user: env.email.smtpUser, pass: env.email.smtpPassword } : undefined,
      });
      await transport.sendMail({
        from: env.email.fromAddress,
        to: row.to_email,
        subject: row.subject,
        text: row.body,
        html: row.html ?? undefined,
      });
      await markEmailSent(row.id, "smtp");
      return { ok: true, provider: "smtp" };
    }

    throw new Error(`Unknown EMAIL_PROVIDER: ${env.email.provider}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markEmailFailed(row.id, message);
    logger.error("Email delivery failed", { to: row.to_email, error: message });
    return { ok: false, provider: env.email.provider, error: message };
  }
}

/** Drains the outbox. Called by the cron entry point and after critical events. */
export async function processEmailOutbox(limit = 25): Promise<{ sent: number; failed: number }> {
  const rows = await listQueuedEmails(limit);
  let sent = 0;
  let failed = 0;
  for (const row of rows) {
    const result = await deliverEmail(row);
    if (result.ok) sent += 1;
    else failed += 1;
  }
  return { sent, failed };
}

/** Convenience: queue + attempt immediately (used for transactional mail). */
export async function sendEmailNow(input: {
  to: string;
  subject: string;
  body: string;
  locale?: Locale;
  customerId?: string | null;
  template?: string | null;
  isDemo?: number;
}): Promise<{ ok: boolean; error?: string }> {
  const locale = input.locale ?? "ar";
  const row = await enqueueEmail({
    ...input,
    html: renderEmailHtml({ to: input.to, subject: input.subject, body: input.body }, locale),
  });
  const result = await deliverEmail(row);
  return { ok: result.ok, error: result.error };
}

export function emailProviderStatus(): { provider: string; configured: boolean; note: string } {
  const env = getEnv();
  const provider = env.email.provider;
  const configured =
    provider === "console" ||
    (provider === "resend" && Boolean(env.email.resendApiKey)) ||
    (provider === "smtp" && Boolean(env.email.smtpHost));
  return {
    provider,
    configured,
    note:
      provider === "console"
        ? "Messages are written to the server log — no external mail account is connected yet."
        : configured
          ? "Provider credentials found in the environment."
          : "Provider selected but its credentials are missing; messages stay queued in the outbox.",
  };
}
