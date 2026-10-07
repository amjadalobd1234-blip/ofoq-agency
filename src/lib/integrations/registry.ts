import { getEnv } from "@/lib/config/env";
import { listIntegrations } from "@/lib/repositories/governance.repo";

import { aiStatus } from "@/lib/ai/provider";
import { encryptionAvailable } from "./crypto";
import { googleAdsStatus } from "./google-ads";
import { paymentProviderStatus } from "./payments";
import { whatsappStatus } from "./whatsapp";

/**
 * Central integration registry.
 *
 * One screen in the dashboard answers "what is connected, what is not, and what
 * exactly do I need to do to finish the setup". Every entry states its state
 * honestly — nothing is reported as connected unless it truly is.
 */
export type IntegrationState = "connected" | "available" | "not_connected" | "disabled" | "error";

export interface IntegrationInfo {
  key: string;
  nameAr: string;
  nameEn: string;
  state: IntegrationState;
  requiredFor: string[];
  summaryAr: string;
  summaryEn: string;
  setupStepsAr: string[];
  setupStepsEn: string[];
  missingConfig: string[];
  docsPath: string;
}

export async function listIntegrationStatuses(): Promise<IntegrationInfo[]> {
  const env = getEnv();
  const stored = await listIntegrations();
  const storedByProvider = new Map(stored.map((row) => [row.provider, row]));

  const ai = aiStatus();
  const payments = paymentProviderStatus();
  const googleAds = googleAdsStatus();
  const whatsapp = whatsappStatus();

  const integrations: IntegrationInfo[] = [
    {
      key: "email",
      nameAr: "البريد الإلكتروني",
      nameEn: "Email",
      state: env.email.live ? "connected" : "available",
      requiredFor: ["Email verification", "Password reset", "Notifications", "Daily reports"],
      summaryAr: env.email.live
        ? `البريد مُهيّأ عبر ${env.email.provider}.`
        : "البريد يعمل حاليًا بوضع التطوير: الرسائل تُسجَّل في قاعدة البيانات (صندوق الصادر) ولا تُرسل فعليًا.",
      summaryEn: env.email.live
        ? `Email is configured through ${env.email.provider}.`
        : "Email runs in development mode: messages are stored in the outbox and not actually delivered.",
      setupStepsAr: [
        "اختر EMAIL_PROVIDER=smtp أو resend.",
        "أضف بيانات المزود في .env (SMTP_HOST و SMTP_USER و SMTP_PASSWORD أو RESEND_API_KEY).",
      ],
      setupStepsEn: [
        "Set EMAIL_PROVIDER to smtp or resend.",
        "Add the provider credentials in .env (SMTP_HOST, SMTP_USER, SMTP_PASSWORD or RESEND_API_KEY).",
      ],
      missingConfig: env.email.live ? [] : ["EMAIL_PROVIDER + credentials"],
      docsPath: "docs/INTEGRATIONS.md#email",
    },
    {
      key: "ai",
      nameAr: "مزود الذكاء الاصطناعي",
      nameEn: "AI model provider",
      state: ai.available ? "connected" : "available",
      requiredFor: ["Assistant wording", "Free-text understanding", "Translation", "Content drafting"],
      summaryAr: ai.available
        ? `متصل عبر ${ai.provider} (الموديل ${ai.model}).`
        : "غير متصل. المنصة تعمل بمحرك قواعد داخلي يغطي المحادثة والتسعير والعروض دون أي مزود خارجي.",
      summaryEn: ai.available
        ? `Connected via ${ai.provider} (model ${ai.model}).`
        : "Not connected. The platform runs on its built-in rules engine for chat, pricing and offers — no external provider needed.",
      setupStepsAr: [
        "اختر AI_PROVIDER=openai_compatible.",
        "أضف AI_API_KEY و AI_BASE_URL و AI_MODEL.",
        "يمكن استخدام أي مزود متوافق مع OpenAI، أو نموذج محلي.",
      ],
      setupStepsEn: [
        "Set AI_PROVIDER=openai_compatible.",
        "Add AI_API_KEY, AI_BASE_URL and AI_MODEL.",
        "Any OpenAI-compatible endpoint or a local model works.",
      ],
      missingConfig: ai.available ? [] : ["AI_PROVIDER + AI_API_KEY"],
      docsPath: "docs/INTEGRATIONS.md#ai-provider",
    },
    {
      key: "payments",
      nameAr: "المدفوعات",
      nameEn: "Payments",
      state: payments.connected ? "connected" : "not_connected",
      requiredFor: ["Invoice settlement inside the platform"],
      summaryAr: payments.reason?.startsWith("Manual")
        ? "الدفع اليدوي مفعّل: يسجّل الفريق التحويل أو الدفع النقدي مقابل الفاتورة. الدفع الإلكتروني غير مفعّل بعد."
        : "الدفع الإلكتروني غير مفعّل: البنية جاهزة لكن التنفيذ لم يكتمل مع بوابة حقيقية.",
      summaryEn: payments.reason ?? "",
      setupStepsAr: payments.setupInstructionsAr,
      setupStepsEn: payments.setupInstructionsEn,
      missingConfig: env.payments.onlineCheckoutEnabled ? [] : ["online checkout adapter"],
      docsPath: "docs/INTEGRATIONS.md#payments",
    },
    {
      key: "google_ads",
      nameAr: "Google Ads",
      nameEn: "Google Ads",
      state: googleAds.connected ? "connected" : googleAds.enabled ? "not_connected" : "disabled",
      requiredFor: ["Campaign metrics sync", "Automated optimisation", "Ad spend reporting"],
      summaryAr: googleAds.reasonAr,
      summaryEn: googleAds.reasonEn,
      setupStepsAr: googleAds.setupStepsAr,
      setupStepsEn: googleAds.setupStepsEn,
      missingConfig: googleAds.missingConfig,
      docsPath: "docs/INTEGRATIONS.md#google-ads",
    },
    {
      key: "whatsapp",
      nameAr: "واتساب للأعمال",
      nameEn: "WhatsApp Business",
      state: whatsapp.connected ? "connected" : whatsapp.enabled ? "not_connected" : "disabled",
      requiredFor: ["WhatsApp conversations in the unified inbox"],
      summaryAr: whatsapp.reasonAr,
      summaryEn: whatsapp.reasonEn,
      setupStepsAr: whatsapp.setupStepsAr,
      setupStepsEn: whatsapp.setupStepsEn,
      missingConfig: whatsapp.missingConfig,
      docsPath: "docs/INTEGRATIONS.md#whatsapp",
    },
    {
      key: "google_signin",
      nameAr: "الدخول عبر Google",
      nameEn: "Google sign-in",
      state: env.google.enabled ? "connected" : "available",
      requiredFor: ["Client sign-in with Google"],
      summaryAr: env.google.enabled
        ? "مفعّل: يمكن للعملاء تسجيل الدخول بحساب Google."
        : "غير مفعّل. الدخول بالبريد وكلمة المرور يعمل بشكل كامل.",
      summaryEn: env.google.enabled
        ? "Enabled: clients can sign in with Google."
        : "Disabled. Email and password sign-in works fully.",
      setupStepsAr: [
        "أنشئ OAuth Client ID في Google Cloud Console.",
        `أضف رابط التحويل: ${env.google.redirectUri}`,
        "أضف GOOGLE_CLIENT_ID و GOOGLE_CLIENT_SECRET في .env.",
      ],
      setupStepsEn: [
        "Create an OAuth Client ID in Google Cloud Console.",
        `Add the redirect URI: ${env.google.redirectUri}`,
        "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.",
      ],
      missingConfig: env.google.enabled ? [] : ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
      docsPath: "docs/INTEGRATIONS.md#google-sign-in",
    },
    {
      key: "token_storage",
      nameAr: "تشفير رموز التكامل",
      nameEn: "Integration token encryption",
      state: encryptionAvailable() ? "connected" : "not_connected",
      requiredFor: ["Storing OAuth refresh tokens (Google Ads, WhatsApp)"],
      summaryAr: encryptionAvailable()
        ? "مفعّل: الرموز تُخزَّن مشفّرة بـ AES-256-GCM."
        : "غير مفعّل: بدون APP_ENCRYPTION_KEY لن تُخزَّن أي رموز خارجية، لذلك تبقى تكاملات Google Ads وواتساب معطّلة.",
      summaryEn: encryptionAvailable()
        ? "Enabled: tokens are stored with AES-256-GCM."
        : "Disabled: without APP_ENCRYPTION_KEY no third-party tokens can be stored, so Google Ads and WhatsApp stay off.",
      setupStepsAr: ["أنشئ مفتاحًا: openssl rand -base64 32", "أضفه إلى APP_ENCRYPTION_KEY في .env."],
      setupStepsEn: ["Generate a key: openssl rand -base64 32", "Add it as APP_ENCRYPTION_KEY in .env."],
      missingConfig: encryptionAvailable() ? [] : ["APP_ENCRYPTION_KEY"],
      docsPath: "docs/SECURITY.md#token-encryption",
    },
  ];

  // Surface any provider that a previous setup attempt stored as ERROR.
  for (const [provider, row] of storedByProvider) {
    if (row.status !== "ERROR") continue;
    const existing = integrations.find((item) => item.key === provider);
    if (existing) {
      existing.state = "error";
      existing.summaryEn = row.last_error ?? existing.summaryEn;
      existing.summaryAr = row.last_error ?? existing.summaryAr;
    }
  }

  return integrations;
}

export async function integrationSummary(): Promise<{
  connected: number;
  notConnected: number;
  integrations: IntegrationInfo[];
}> {
  const integrations = await listIntegrationStatuses();
  return {
    connected: integrations.filter((item) => item.state === "connected").length,
    notConnected: integrations.filter((item) => item.state !== "connected").length,
    integrations,
  };
}
