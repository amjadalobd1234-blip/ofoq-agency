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
 * Every message is written to the outbox first and delivered afterwards, so a
 * provider outage never loses a notification. With `EMAIL_PROVIDER=console` (the
 * default) mail is printed to the server log — the whole flow is therefore
 * testable before any SMTP/Resend account exists, and nothing here pretends to
 * send through a provider that was never configured.
 */

export interface SendEmailInput {
  to: string;
  subject: string;
  text: string;
  html?: string | null;
  /** Linked user, so the message is visible on their profile/history. */
  userId?: string | null;
  customerId?: string | null;
  template?: string | null;
  meta?: unknown;
  locale?: Locale;
  isDemo?: number;
}

export interface SendEmailResult {
  delivered: boolean;
  queued: boolean;
  provider: string;
  outboxId?: string;
  error?: string;
}

export interface EmailBrand {
  agencyName: string;
  primary: string;
  accent: string;
}

export const DEFAULT_EMAIL_BRAND: EmailBrand = { agencyName: "أفق | Ofoq", primary: "#0b1220", accent: "#c8a24a" };

/** The shared bilingual, RTL-aware shell used by every platform email. */
export function renderEmailHtml(
  input: { subject: string; text: string; html?: string | null },
  locale: Locale = "ar",
  brand: EmailBrand = DEFAULT_EMAIL_BRAND,
): string {
  const dir = locale === "ar" ? "rtl" : "ltr";
  const align = locale === "ar" ? "right" : "left";
  const body = input.html ?? escapeHtml(input.text).replace(/\n/g, "<br />");
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
              <h1 style="margin:0 0 12px;font-size:18px;color:${brand.primary};">${escapeHtml(input.subject)}</h1>
              ${body}
            </td>
          </tr>
          <tr>
            <td style="padding:16px 24px;background:${brand.primary};color:#c9ccd6;font-size:12px;text-align:${align};">
              ${
                locale === "ar"
                  ? "هذه رسالة من منصة أفق. لا نطلب بيانات بطاقتك عبر البريد."
                  : "This message comes from the Ofoq platform. We never ask for card details by email."
              }
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

/** Queues a message so it survives a provider outage, then delivers it. */
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const env = getEnv();
  const locale = input.locale ?? "ar";

  try {
    const row = await queueEmail({
      to_email: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html ?? renderEmailHtml({ subject: input.subject, text: input.text }, locale),
      template: input.template ?? undefined,
      to_user_id: input.userId ?? null,
      provider: env.email.provider,
      meta: {
        ...(typeof input.meta === "object" && input.meta !== null ? (input.meta as Record<string, unknown>) : {}),
        customerId: input.customerId ?? null,
        isDemo: input.isDemo === 1,
      },
    });

    const delivery = await deliverEmail(row);
    return {
      delivered: delivery.ok,
      queued: true,
      provider: delivery.provider,
      outboxId: row.id,
      error: delivery.error,
    };
  } catch (error) {
    // Queuing itself failed: report honestly instead of claiming success.
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Failed to queue email", { to: input.to, error: message });
    return { delivered: false, queued: false, provider: env.email.provider, error: message };
  }
}

/** Delivers one queued row and records the outcome on it. */
export async function deliverEmail(row: OutboxEmailRow): Promise<{ ok: boolean; provider: string; error?: string }> {
  const env = getEnv();
  const text = row.text ?? "";

  try {
    if (env.email.provider === "console") {
      logger.info("[email:console] message delivered to the server log", {
        to: row.to_email,
        subject: row.subject,
        preview: text.slice(0, 400),
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
          from: `${env.email.fromName} <${env.email.from}>`,
          to: [row.to_email],
          subject: row.subject,
          text,
          html: row.html ?? undefined,
        }),
      });
      if (!response.ok) throw new Error(`Resend responded ${response.status}`);
      await markEmailSent(row.id, "resend");
      return { ok: true, provider: "resend" };
    }

    if (env.email.provider === "smtp") {
      if (!env.email.smtp.host) throw new Error("SMTP_HOST is not set");
      // nodemailer is an optional dependency: install it only when SMTP is used.
      // @ts-expect-error nodemailer is optional and is not part of the default install.
      const nodemailer = (await import("nodemailer").catch(() => null)) as NodemailerModule | null;
      if (!nodemailer) {
        throw new Error("nodemailer is not installed. Run `npm i nodemailer` and restart to use EMAIL_PROVIDER=smtp.");
      }
      const transport = nodemailer.createTransport({
        host: env.email.smtp.host,
        port: env.email.smtp.port,
        secure: env.email.smtp.secure,
        auth: env.email.smtp.user ? { user: env.email.smtp.user, pass: env.email.smtp.password } : undefined,
      });
      await transport.sendMail({
        from: `${env.email.fromName} <${env.email.from}>`,
        to: row.to_email,
        subject: row.subject,
        text,
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

/** Drains the outbox. Called by the daily job so failures are retried. */
export async function processOutbox(limit = 25): Promise<{ sent: number; failed: number; attempted: number }> {
  const rows = await listQueuedEmails(limit);
  let sent = 0;
  let failed = 0;
  for (const row of rows) {
    const result = await deliverEmail(row);
    if (result.ok) sent += 1;
    else failed += 1;
  }
  return { sent, failed, attempted: rows.length };
}

/** Alias kept for readability at call sites that resend the whole queue. */
export const processEmailOutbox = processOutbox;

export function emailProviderStatus(): { provider: string; configured: boolean; note: string } {
  const env = getEnv();
  const provider = env.email.provider;
  const configured =
    provider === "console" ||
    (provider === "resend" && Boolean(env.email.resendApiKey)) ||
    (provider === "smtp" && Boolean(env.email.smtp.host));
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

/* --------------------------------------------------------- optional provider -- */

interface SmtpTransport {
  sendMail(options: {
    from: string;
    to: string;
    subject: string;
    text: string;
    html?: string;
  }): Promise<unknown>;
}

interface NodemailerModule {
  createTransport(options: {
    host: string;
    port: number;
    secure: boolean;
    auth?: { user: string; pass: string };
  }): SmtpTransport;
}
