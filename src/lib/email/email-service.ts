/**
 * Email service — Resend, with ready-made bilingual templates.
 *
 * Rules:
 *  1. The API key is read from `process.env.RESEND_API_KEY` only. No key is ever
 *     written in code, and it is never logged.
 *  2. A missing key is not an error: the service falls back to the console
 *     transport (the message is written to the server log) so the platform keeps
 *     working — and keeps rendering real templates — before Resend is connected.
 *  3. Templates are pure functions returning `{ subject, text, html }`, which
 *     makes them testable without touching the network.
 *
 * Client-facing copy is Arabic-first with an English variant, matching the rest
 * of the platform. Every interpolation is HTML-escaped.
 */
import { Resend, type CreateEmailOptions } from "resend";

import { logger } from "@/lib/core/logger";
import { formatMoney, toMinor } from "@/lib/core/money";

export type Locale = "ar" | "en";

/** Resend's shared test sender, used only when EMAIL_FROM is not configured. */
const DEFAULT_FROM_ADDRESS = "onboarding@resend.dev";

export interface EmailTemplate {
  subject: string;
  text: string;
  html: string;
}

export interface SendEmailInput {
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  replyTo?: string;
}

export interface EmailDeliveryResult {
  /** True only when the provider accepted the message. */
  delivered: boolean;
  provider: "resend" | "console";
  id: string | null;
  to: string[];
  subject: string;
  error?: string;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Loose validation: enough to stop typos, never a reason to crash a flow. */
export function isValidEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value.trim());
}

export function resendApiKey(): string {
  return (process.env.RESEND_API_KEY ?? "").trim();
}

/** Exposed for the owner integrations screen. */
export function emailStatus(): { provider: "resend" | "console"; configured: boolean; from: string } {
  const key = resendApiKey();
  return { provider: key ? "resend" : "console", configured: key.length > 0, from: fromAddress() };
}

/** `أفق | Ofoq <no-reply@domain>` — composed from env, never hardcoded to a domain. */
export function fromAddress(): string {
  const address = (process.env.EMAIL_FROM ?? "").trim();
  const name = (process.env.EMAIL_FROM_NAME ?? "أفق | Ofoq").trim();
  if (address.includes("<")) return address;
  return `${name} <${address || DEFAULT_FROM_ADDRESS}>`;
}

/**
 * Sends one message.
 *
 * Never throws for provider or configuration problems: the caller receives
 * `{ delivered, provider, error }` and decides what to tell the user.
 */
export async function sendEmail(input: SendEmailInput): Promise<EmailDeliveryResult> {
  const recipients = (Array.isArray(input.to) ? input.to : [input.to])
    .map((value) => value.trim())
    .filter(Boolean);
  const subject = input.subject.trim();

  if (recipients.length === 0 || recipients.some((value) => !isValidEmail(value))) {
    return {
      delivered: false,
      provider: resendApiKey() ? "resend" : "console",
      id: null,
      to: recipients,
      subject,
      error: "A valid recipient address is required.",
    };
  }
  if (!subject) {
    return {
      delivered: false,
      provider: resendApiKey() ? "resend" : "console",
      id: null,
      to: recipients,
      subject,
      error: "A subject is required.",
    };
  }
  if (!input.text && !input.html) {
    return {
      delivered: false,
      provider: resendApiKey() ? "resend" : "console",
      id: null,
      to: recipients,
      subject,
      error: "An email must contain text or HTML content.",
    };
  }

  const apiKey = resendApiKey();

  if (!apiKey) {
    // Console transport: the platform works without email credentials.
    logger.info("Email rendered but not delivered: RESEND_API_KEY is not configured", {
      to: recipients.join(", "),
      subject,
      preview: (input.text ?? "").slice(0, 400),
    });
    return { delivered: false, provider: "console", id: null, to: recipients, subject };
  }

  try {
    const resend = new Resend(apiKey);
    // The validation above already guarantees a recipient, a subject and at
    // least one of text/html; the SDK encodes that as an `RequireAtLeastOne<>`
    // union which TypeScript cannot infer through conditional spreads.
    const payload = {
      from: fromAddress(),
      to: recipients,
      subject,
      ...(input.text ? { text: input.text } : {}),
      ...(input.html ? { html: input.html } : {}),
      ...(input.replyTo ? { reply_to: input.replyTo } : {}),
    } as CreateEmailOptions;
    const { data, error } = await resend.emails.send(payload);

    if (error) {
      const detail = [error.name, error.message].filter(Boolean).join(": ");
      logger.error("Resend rejected the message", { to: recipients.join(", "), subject, error: detail });
      return {
        delivered: false,
        provider: "resend",
        id: null,
        to: recipients,
        subject,
        error: detail.slice(0, 300),
      };
    }

    return { delivered: true, provider: "resend", id: data?.id ?? null, to: recipients, subject };
  } catch (error) {
    // Network/timeout failures throw; normalise them into the same result shape.
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Resend call failed", { to: recipients.join(", "), subject, error: message });
    return {
      delivered: false,
      provider: "resend",
      id: null,
      to: recipients,
      subject,
      error: message.slice(0, 300),
    };
  }
}

/** Sends a rendered template in one step. */
export async function sendTemplateEmail(
  to: string | string[],
  template: EmailTemplate,
  options: { replyTo?: string } = {},
): Promise<EmailDeliveryResult> {
  return sendEmail({ to, subject: template.subject, text: template.text, html: template.html, ...options });
}

/* -------------------------------------------------------------------------- */
/* Rendering helpers                                                          */
/* -------------------------------------------------------------------------- */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface LayoutInput {
  title: string;
  intro: string;
  /** Label/value rows rendered as a definition list. */
  facts?: Array<[string, string]>;
  body?: string;
  action?: { label: string; url: string };
  footer: string;
  locale: Locale;
}

/**
 * Escapes a fact value and turns any `http(s)://` URL in it into a link — the
 * owner's service-request email carries the client's wa.me link, which must be
 * tappable from the inbox.
 */
function linkifyHtml(value: string): string {
  const pattern = /https?:\/\/[^\s<>"'،]+/g;
  let html = "";
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    html += escapeHtml(value.slice(last, match.index));
    const url = escapeHtml(match[0]);
    html += `<a href="${url}" dir="ltr" style="color:#d4af37;">${url}</a>`;
    last = match.index + match[0].length;
  }
  return html + escapeHtml(value.slice(last));
}

/** Shared shell so every message looks like it came from the same agency. */
function renderLayout(input: LayoutInput): string {
  const dir = input.locale === "ar" ? "rtl" : "ltr";
  const align = input.locale === "ar" ? "right" : "left";
  const facts = (input.facts ?? [])
    .map(
      ([label, value]) =>
        `<tr><td style="padding:6px 0;color:#8d8878;font-size:12px;">${escapeHtml(label)}</td>` +
        `<td style="padding:6px 0;color:#f2efe6;font-size:13px;font-weight:600;text-align:${align};">${linkifyHtml(value)}</td></tr>`,
    )
    .join("");
  const action = input.action
    ? `<p style="margin:22px 0 0;"><a href="${escapeHtml(input.action.url)}" style="display:inline-block;border-radius:8px;background:#d4af37;padding:11px 18px;color:#141414;font-size:13px;font-weight:700;text-decoration:none;">${escapeHtml(input.action.label)}</a></p>`
    : "";
  const body = input.body
    ? `<p style="margin:0 0 14px;color:#cfcabd;font-size:13px;line-height:1.9;white-space:pre-wrap;">${escapeHtml(input.body)}</p>`
    : "";

  return [
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>',
    `<body style="margin:0;background:#0f0f0f;padding:24px;font-family:'Segoe UI',Tahoma,Arial,sans-serif;" dir="${dir}">`,
    '<div style="max-width:560px;margin:0 auto;border:1px solid rgba(212,175,55,0.25);border-radius:14px;background:#151515;padding:26px;">',
    '<p style="margin:0 0 18px;color:#d4af37;font-size:11px;letter-spacing:2px;text-transform:uppercase;">OFOQ · أفق</p>',
    `<h1 style="margin:0 0 12px;color:#f6f2e8;font-size:20px;text-align:${align};">${escapeHtml(input.title)}</h1>`,
    `<p style="margin:0 0 14px;color:#cfcabd;font-size:13px;line-height:1.9;text-align:${align};">${escapeHtml(input.intro)}</p>`,
    body,
    facts ? `<table style="width:100%;border-collapse:collapse;margin-top:6px;">${facts}</table>` : "",
    action,
    `<p style="margin:24px 0 0;border-top:1px solid rgba(255,255,255,0.08);padding-top:14px;color:#7d7869;font-size:11px;line-height:1.8;text-align:${align};">${escapeHtml(input.footer)}</p>`,
    "</div></body></html>",
  ].join("");
}

function footer(locale: Locale): string {
  return locale === "ar"
    ? "أُرسلت هذه الرسالة من منصة أفق. إن لم تكن تتوقعها، يمكنك تجاهلها بأمان."
    : "Sent by the Ofoq platform. If you were not expecting it, you can safely ignore it.";
}

/** Money input accepted by the templates: major units, minor units, or a string. */
export interface MoneyInput {
  /** Amount in MAJOR units (e.g. 125.5) unless `minorUnits` is true. */
  amount: number | string;
  currency?: string;
  /** Set to true when `amount` is already in the currency's minor unit. */
  minorUnits?: boolean;
}

function formatMoneyInput(money: MoneyInput | number | string, locale: Locale): string {
  const input: MoneyInput = typeof money === "object" && money !== null ? money : { amount: money };
  const currency = (input.currency ?? process.env.DEFAULT_CURRENCY ?? "USD").toUpperCase();
  const minor = input.minorUnits ? Math.round(Number(input.amount)) : toMinor(input.amount, currency);
  return formatMoney(Number.isFinite(minor) ? minor : 0, currency, locale);
}

function pickLocale(locale: Locale | undefined, fallbackText?: string): Locale {
  if (locale) return locale;
  if (fallbackText && /[\u0600-\u06FF]/.test(fallbackText)) return "ar";
  return "ar";
}

/* -------------------------------------------------------------------------- */
/* Ready-made templates                                                       */
/* -------------------------------------------------------------------------- */

/** 1. Welcome message after signup. */
export function welcomeTemplate(name: string, options: { locale?: Locale } = {}): EmailTemplate {
  const locale = pickLocale(options.locale, name);
  const safeName = name.trim() || (locale === "ar" ? "عميلنا" : "there");

  if (locale === "en") {
    return {
      subject: `Welcome to Ofoq, ${safeName}`,
      text: [
        `Hello ${safeName},`,
        "",
        "Welcome to Ofoq. Your account is ready, and the Ofoq assistant can start with you from the first message.",
        "Tell it what you want to achieve and it will collect only what it needs, then propose a service, a timeline and a clear price.",
        "",
        "No payment is taken in the chat, and no price is promised before the scope is agreed.",
        "",
        footer(locale),
      ].join("\n"),
      html: renderLayout({
        title: `Welcome to Ofoq, ${safeName}`,
        intro:
          "Your account is ready. The Ofoq assistant can start with you from the first message and guide you step by step.",
        facts: [
          ["Next step", "Describe your goal in a short chat"],
          ["You get", "A service, a timeline and a clear price"],
          ["Payment", "Only after you approve the scope"],
        ],
        footer: footer(locale),
        locale,
      }),
    };
  }

  return {
    subject: `أهلًا بك في أفق، ${safeName}`,
    text: [
      `مرحبًا ${safeName}،`,
      "",
      "أهلًا بك في أفق. حسابك جاهز، ومساعد أفق يمكنه البدء معك من أول رسالة.",
      "أخبره بالنتيجة التي تريدها، وسيسأل عن التفاصيل الضرورية فقط، ثم يقترح الخدمة والمدة والسعر بشكل واضح.",
      "",
      "لا نطلب أي دفع داخل المحادثة، ولا نعطي سعرًا نهائيًا قبل الاتفاق على نطاق العمل.",
      "",
      footer(locale),
    ].join("\n"),
    html: renderLayout({
      title: `أهلًا بك في أفق، ${safeName}`,
      intro: "حسابك جاهز. مساعد أفق يمكنه البدء معك من أول رسالة ومرافقتك خطوة بخطوة.",
      facts: [
        ["الخطوة التالية", "اشرح هدفك في محادثة قصيرة"],
        ["ما ستحصل عليه", "خدمة ومدة وسعر واضح"],
        ["الدفع", "فقط بعد موافقتك على نطاق العمل"],
      ],
      footer: footer(locale),
      locale,
    }),
  };
}

/** 2. Offer is ready and waiting for the client's review. */
export function offerReadyTemplate(
  name: string,
  offerCode: string,
  total: number | string | MoneyInput,
  options: { locale?: Locale; currency?: string } = {},
): EmailTemplate {
  const locale = pickLocale(options.locale, name);
  const safeName = name.trim() || (locale === "ar" ? "عميلنا" : "there");
  const code = offerCode.trim() || "—";
  const money = formatMoneyInput(
    typeof total === "object" && total !== null ? { currency: options.currency, ...total } : { amount: total, currency: options.currency },
    locale,
  );

  if (locale === "en") {
    return {
      subject: `Your offer ${code} is ready — Ofoq`,
      text: [
        `Hello ${safeName},`,
        "",
        `Offer ${code} is ready for your review.`,
        `Total: ${money}`,
        "",
        "Open your client portal to read the details and confirm the next step. The offer stays valid until you respond.",
        "",
        footer(locale),
      ].join("\n"),
      html: renderLayout({
        title: `Your offer ${code} is ready`,
        intro: `Hello ${safeName}, the agency has prepared your offer. Review it in your client portal and confirm the next step.`,
        facts: [
          ["Offer", code],
          ["Total", money],
          ["Status", "Waiting for your review"],
        ],
        action: { label: "Open the client portal", url: `${appUrl()}/dashboard` },
        footer: footer(locale),
        locale,
      }),
    };
  }

  return {
    subject: `عرضك ${code} جاهز — أفق`,
    text: [
      `مرحبًا ${safeName}،`,
      "",
      `العرض ${code} جاهز للمراجعة.`,
      `الإجمالي: ${money}`,
      "",
      "افتح بوابة العميل للاطلاع على التفاصيل وتأكيد الخطوة التالية. يبقى العرض بانتظار ردك.",
      "",
      footer(locale),
    ].join("\n"),
    html: renderLayout({
      title: `عرضك ${code} جاهز`,
      intro: `مرحبًا ${safeName}، أعدّت الوكالة عرضك. راجعه من بوابة العميل وأكّد الخطوة التالية.`,
      facts: [
        ["العرض", code],
        ["الإجمالي", money],
        ["الحالة", "بانتظار مراجعتك"],
      ],
      action: { label: "افتح بوابة العميل", url: `${appUrl()}/dashboard` },
      footer: footer(locale),
      locale,
    }),
  };
}

/** 3. Invoice issued for a client. */
export function invoiceTemplate(
  name: string,
  number: string,
  amount: number | string | MoneyInput,
  options: { locale?: Locale; currency?: string; dueDate?: string } = {},
): EmailTemplate {
  const locale = pickLocale(options.locale, name);
  const safeName = name.trim() || (locale === "ar" ? "عميلنا" : "there");
  const invoiceNumber = number.trim() || "—";
  const money = formatMoneyInput(
    typeof amount === "object" && amount !== null
      ? { currency: options.currency, ...amount }
      : { amount, currency: options.currency },
    locale,
  );

  if (locale === "en") {
    return {
      subject: `Invoice ${invoiceNumber} from Ofoq`,
      text: [
        `Hello ${safeName},`,
        "",
        `Invoice ${invoiceNumber} has been issued.`,
        `Amount: ${money}`,
        options.dueDate ? `Due date: ${options.dueDate}` : "",
        "",
        "You can find the invoice and its payment records in your client portal.",
        "",
        footer(locale),
      ]
        .filter(Boolean)
        .join("\n"),
      html: renderLayout({
        title: `Invoice ${invoiceNumber}`,
        intro: `Hello ${safeName}, invoice ${invoiceNumber} has been issued to your account.`,
        facts: [
          ["Invoice", invoiceNumber],
          ["Amount", money],
          ...(options.dueDate ? ([["Due date", options.dueDate]] as Array<[string, string]>) : []),
        ],
        action: { label: "View the invoice", url: `${appUrl()}/dashboard` },
        footer: footer(locale),
        locale,
      }),
    };
  }

  return {
    subject: `فاتورتك ${invoiceNumber} من أفق`,
    text: [
      `مرحبًا ${safeName}،`,
      "",
      `تم إصدار الفاتورة ${invoiceNumber}.`,
      `المبلغ: ${money}`,
      options.dueDate ? `تاريخ الاستحقاق: ${options.dueDate}` : "",
      "",
      "تجد الفاتورة وسجل الدفعات في بوابة العميل.",
      "",
      footer(locale),
    ]
      .filter(Boolean)
      .join("\n"),
    html: renderLayout({
      title: `الفاتورة ${invoiceNumber}`,
      intro: `مرحبًا ${safeName}، تم إصدار الفاتورة ${invoiceNumber} على حسابك.`,
      facts: [
        ["الفاتورة", invoiceNumber],
        ["المبلغ", money],
        ...(options.dueDate ? ([["تاريخ الاستحقاق", options.dueDate]] as Array<[string, string]>) : []),
      ],
      action: { label: "عرض الفاتورة", url: `${appUrl()}/dashboard` },
      footer: footer(locale),
      locale,
    }),
  };
}

/** 4. Internal alert for the owner (and partners) — always Arabic-first. */
export function alertOwnerTemplate(
  title: string,
  body: string,
  options: { locale?: Locale; severity?: string; linkPath?: string } = {},
): EmailTemplate {
  const locale = pickLocale(options.locale, title);
  const safeTitle = title.trim() || (locale === "ar" ? "تنبيه من المنصة" : "Platform alert");
  const severity = (options.severity ?? "INFO").toUpperCase();
  const link = `${appUrl()}${options.linkPath?.startsWith("/") ? options.linkPath : "/admin"}`;

  if (locale === "en") {
    return {
      subject: `[Ofoq alert] ${safeTitle}`,
      text: [`Alert: ${safeTitle}`, `Severity: ${severity}`, "", body.trim(), "", `Details: ${link}`, "", footer(locale)].join("\n"),
      html: renderLayout({
        title: safeTitle,
        intro: "An internal platform alert needs attention.",
        body: body.trim(),
        facts: [["Severity", severity]],
        action: { label: "Open the control room", url: link },
        footer: footer(locale),
        locale,
      }),
    };
  }

  return {
    subject: `[تنبيه أفق] ${safeTitle}`,
    text: [`تنبيه: ${safeTitle}`, `الأولوية: ${severity}`, "", body.trim(), "", `التفاصيل: ${link}`, "", footer(locale)].join("\n"),
    html: renderLayout({
      title: safeTitle,
      intro: "تنبيه داخلي من منصة أفق يحتاج إلى مراجعة.",
      body: body.trim(),
      facts: [["الأولوية", severity]],
      action: { label: "افتح لوحة المراقبة", url: link },
      footer: footer(locale),
      locale,
    }),
  };
}

/** 5. A client asked for a human: hand the conversation over to the team. */
export function humanEscalationTemplate(
  clientName: string,
  message: string,
  options: { locale?: Locale; clientEmail?: string; conversationId?: string } = {},
): EmailTemplate {
  const locale = pickLocale(options.locale, clientName);
  const safeName = clientName.trim() || (locale === "ar" ? "عميل" : "A client");
  const text = message.trim();

  return {
    subject:
      locale === "en"
        ? `[Ofoq] ${safeName} asked to speak with a human`
        : `[أفق] ${safeName} طلب التحدث مع فريق بشري`,
    text: [
      locale === "en" ? `${safeName} asked for a human team member.` : `${safeName} طلب التواصل مع فريق بشري.`,
      "",
      locale === "en" ? "Their message:" : "نص الرسالة:",
      text || (locale === "en" ? "(no message provided)" : "(لا توجد رسالة)"),
      "",
      options.clientEmail ? `${locale === "en" ? "Client email" : "بريد العميل"}: ${options.clientEmail}` : "",
      options.conversationId ? `${locale === "en" ? "Conversation" : "المحادثة"}: ${options.conversationId}` : "",
      "",
      locale === "en"
        ? "Reply from the control room so the client is not left waiting."
        : "الرجاء الرد من لوحة المراقبة حتى لا يبقى العميل بانتظار.",
      "",
      footer(locale),
    ]
      .filter(Boolean)
      .join("\n"),
    html: renderLayout({
      title: locale === "en" ? `${safeName} asked to speak with a human` : `${safeName} طلب التحدث مع فريق بشري`,
      intro:
        locale === "en"
          ? "A client explicitly asked for a human handoff. This is a real request, not an automated greeting."
          : "أحد العملاء طلب صراحةً التواصل مع فريق بشري. هذا طلب فعلي وليس رسالة ترحيب آلية.",
      body: text || (locale === "en" ? "(no message provided)" : "(لا توجد رسالة)"),
      facts: [
        ...(options.clientEmail ? ([["البريد", options.clientEmail]] as Array<[string, string]>) : []),
        ...(options.conversationId ? ([["المحادثة", options.conversationId]] as Array<[string, string]>) : []),
      ],
      action: { label: locale === "en" ? "Open the control room" : "افتح لوحة المراقبة", url: `${appUrl()}/admin` },
      footer: footer(locale),
      locale,
    }),
  };
}

/** 6. A new service request completed in the chat: told to the owner. */
export interface ServiceRequestEmailDetails {
  /** Order reference, e.g. OFOQ-2026-001. */
  orderCode: string;
  service: string;
  size: string;
  budget: string;
  targetArea: string;
  /** Published price range, or a note that the scope needs review. */
  priceRange: string;
  contactChannel: string;
  contactValue?: string | null;
  locale?: Locale;
}

export function serviceRequestOwnerTemplate(
  details: ServiceRequestEmailDetails,
  options: { locale?: Locale } = {},
): EmailTemplate {
  const locale = pickLocale(options.locale ?? details.locale, details.orderCode);
  const order = details.orderCode.trim() || "OFOQ-2026-001";
  const contact = details.contactValue ? `${details.contactChannel} — ${details.contactValue}` : details.contactChannel;
  const facts: Array<[string, string]> = locale === "en"
    ? [
        ["Order", `#${order}`],
        ["Service", details.service],
        ["Size", details.size],
        ["Budget", details.budget],
        ["Target area", details.targetArea],
        ["Price range", details.priceRange],
        ["Contact channel", contact],
      ]
    : [
        ["رقم الطلب", `#${order}`],
        ["الخدمة", details.service],
        ["الحجم", details.size],
        ["الميزانية", details.budget],
        ["المنطقة المستهدفة", details.targetArea],
        ["نطاق السعر", details.priceRange],
        ["قناة التواصل", contact],
      ];
  const link = `${appUrl()}/admin/alerts`;
  const title = locale === "en" ? `New service request #${order}` : `طلب خدمة جديد #${order}`;
  const intro =
    locale === "en"
      ? "The Ofoq assistant just finished a guided service request. Every detail is below."
      : "مساعد أفق أنهى للتو طلب خدمة موجّهاً. كل التفاصيل في الأسفل.";
  const body = locale === "en" ? "Request details:" : "تفاصيل الطلب:";

  return {
    subject: `🔔 ${title}`,
    text: [
      title,
      "",
      intro,
      "",
      body,
      ...facts.map(([label, value]) => `- ${label}: ${value}`),
      "",
      locale === "en" ? `Details: ${link}` : `التفاصيل: ${link}`,
      "",
      footer(locale),
    ].join("\n"),
    html: renderLayout({
      title,
      intro,
      body,
      facts,
      action: { label: locale === "en" ? "Open the control room" : "افتح لوحة المراقبة", url: link },
      footer: footer(locale),
      locale,
    }),
  };
}

/** Absolute app URL used inside email buttons. */
export function appUrl(): string {
  const configured = (process.env.APP_URL ?? "").trim();
  return (configured || "http://localhost:3000").replace(/\/$/, "");
}

/* -------------------------------------------------------------------------- */
/* Template registry (used by POST /api/email/send)                           */
/* -------------------------------------------------------------------------- */

export const EMAIL_TEMPLATE_NAMES = [
  "welcome",
  "offer_ready",
  "invoice",
  "alert_owner",
  "human_escalation",
  "service_request_owner",
] as const;

export type EmailTemplateName = (typeof EMAIL_TEMPLATE_NAMES)[number];

/** Two-letter iso code accepted for the optional `locale` field. */
export function isLocale(value: unknown): value is Locale {
  return value === "ar" || value === "en";
}

function requireString(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Template field "${key}" is required and must be a non-empty string.`);
  }
  return value;
}

/**
 * Renders a template by name.
 *
 * Inputs are re-validated here (routes validate first) so a direct call from a
 * job or a script can never produce a half-empty email.
 */
export function renderEmailTemplate(name: EmailTemplateName, data: Record<string, unknown>): EmailTemplate {
  const locale = isLocale(data.locale) ? data.locale : undefined;

  switch (name) {
    case "welcome":
      return welcomeTemplate(requireString(data, "name"), { locale });
    case "offer_ready": {
      const total = data.total;
      if (typeof total !== "number" && typeof total !== "string") {
        throw new Error('Template field "total" is required and must be a number.');
      }
      return offerReadyTemplate(requireString(data, "name"), requireString(data, "offerCode"), total, {
        locale,
        currency: typeof data.currency === "string" ? data.currency : undefined,
      });
    }
    case "invoice": {
      const amount = data.amount;
      if (typeof amount !== "number" && typeof amount !== "string") {
        throw new Error('Template field "amount" is required and must be a number.');
      }
      return invoiceTemplate(requireString(data, "name"), requireString(data, "number"), amount, {
        locale,
        currency: typeof data.currency === "string" ? data.currency : undefined,
        dueDate: typeof data.dueDate === "string" ? data.dueDate : undefined,
      });
    }
    case "alert_owner":
      return alertOwnerTemplate(requireString(data, "title"), typeof data.body === "string" ? data.body : "", {
        locale,
        severity: typeof data.severity === "string" ? data.severity : undefined,
        linkPath: typeof data.linkPath === "string" ? data.linkPath : undefined,
      });
    case "human_escalation":
      return humanEscalationTemplate(
        requireString(data, "clientName"),
        typeof data.message === "string" ? data.message : "",
        {
          locale,
          clientEmail: typeof data.clientEmail === "string" ? data.clientEmail : undefined,
          conversationId: typeof data.conversationId === "string" ? data.conversationId : undefined,
        },
      );
    case "service_request_owner":
      return serviceRequestOwnerTemplate(
        {
          orderCode: requireString(data, "orderCode"),
          service: requireString(data, "service"),
          size: requireString(data, "size"),
          budget: requireString(data, "budget"),
          targetArea: requireString(data, "targetArea"),
          priceRange: requireString(data, "priceRange"),
          contactChannel: requireString(data, "contactChannel"),
          contactValue: typeof data.contactValue === "string" ? data.contactValue : undefined,
        },
        { locale },
      );
    default:
      throw new Error(`Unknown email template "${String(name)}".`);
  }
}
