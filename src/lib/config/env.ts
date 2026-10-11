import { loadEnvFiles } from "./load-env";

loadEnvFiles();

/**
 * Central environment configuration.
 *
 * Rules enforced here:
 *  1. Every secret comes from the environment — never from source code.
 *  2. Integrations default to a DISABLED state; nothing is assumed to exist.
 *  3. Reading a value never throws (except for production auth hardening
 *     checks), so a partially configured deployment still boots.
 */

export type AiProvider = "none" | "openai_compatible";
export type EmailProvider = "console" | "smtp" | "resend";
export type PaymentsProvider = "manual" | "stripe";
export type DatabaseDriverName = "sqlite" | "postgres";

function str(key: string, fallback = ""): string {
  const value = process.env[key];
  if (value === undefined) return fallback;
  return value.trim();
}

function bool(key: string, fallback = false): boolean {
  const value = str(key).toLowerCase();
  if (!value) return fallback;
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function num(key: string, fallback: number): number {
  const value = Number(str(key));
  return Number.isFinite(value) ? value : fallback;
}

function oneOf<T extends string>(value: string, allowed: readonly T[], fallback: T): T {
  const normalised = value.toLowerCase() as T;
  return allowed.includes(normalised) ? normalised : fallback;
}

function isProduction(): boolean {
  return str("NODE_ENV", process.env.NODE_ENV ?? "development") === "production";
}

export interface AppEnv {
  nodeEnv: string;
  isProduction: boolean;
  appUrl: string;
  appDomain: string;
  appNameAr: string;
  appNameEn: string;
  defaultLocale: "ar" | "en";

  database: {
    driver: DatabaseDriverName;
    sqlitePath: string;
    url: string;
  };

  auth: {
    secret: string;
    sessionTtlHours: number;
    cookieSecure: boolean;
    encryptionKey: string;
    trustedOrigins: string[];
  };

  google: {
    clientId: string;
    clientSecret: string;
    enabled: boolean;
    redirectUri: string;
  };

  ai: {
    provider: AiProvider;
    apiKey: string;
    baseUrl: string;
    model: string;
    temperature: number;
    maxTokens: number;
    timeoutMs: number;
    enabled: boolean;
  };

  gemini: {
    apiKey: string;
    model: string;
    enabled: boolean;
  };

  email: {
    provider: EmailProvider;
    from: string;
    fromName: string;
    smtp: { host: string; port: number; user: string; password: string; secure: boolean };
    resendApiKey: string;
    /** True when email is delivered by a real provider rather than logged. */
    live: boolean;
    /**
     * Addresses that must hear about every human handoff (OWNER_EMAIL, comma
     * separated). Empty means "use the staff rows in the database", with the
     * documented agency fallback applied by the escalation service.
     */
    ownerEmails: string[];
  };

  payments: {
    provider: PaymentsProvider;
    stripeSecretKey: string;
    stripeWebhookSecret: string;
    defaultCurrency: string;
    /** Online card checkout is only offered once a provider is truly wired up. */
    onlineCheckoutEnabled: boolean;
  };

  googleAds: {
    enabled: boolean;
    apiVersion: string;
    developerToken: string;
    clientId: string;
    clientSecret: string;
    refreshToken: string;
    loginCustomerId: string;
    connected: boolean;
  };

  whatsapp: {
    enabled: boolean;
    provider: "meta_cloud";
    phoneNumberId: string;
    accessToken: string;
    verifyToken: string;
    appSecret: string;
    connected: boolean;
  };

  cronSecret: string;
  dailyReportHour: number;
  seedDemoData: boolean;
}

export function getEnv(): AppEnv {
  const appUrl = str("APP_URL", "http://localhost:3000").replace(/\/$/, "");
  const authSecret = str("AUTH_SECRET", "");

  const googleClientId = str("GOOGLE_CLIENT_ID");
  const googleClientSecret = str("GOOGLE_CLIENT_SECRET");

  const aiProvider = oneOf<AiProvider>(str("AI_PROVIDER", "none"), ["none", "openai_compatible"], "none");
  const aiApiKey = str("AI_API_KEY");

  const emailProvider = oneOf<EmailProvider>(
    str("EMAIL_PROVIDER", "console"),
    ["console", "smtp", "resend"],
    "console",
  );
  const smtpHost = str("SMTP_HOST");
  const resendApiKey = str("RESEND_API_KEY");

  const paymentsProvider = oneOf<PaymentsProvider>(
    str("PAYMENTS_PROVIDER", "manual"),
    ["manual", "stripe"],
    "manual",
  );
  const stripeSecretKey = str("STRIPE_SECRET_KEY");

  const googleAdsEnabled = bool("GOOGLE_ADS_ENABLED", false);
  const whatsappEnabled = bool("WHATSAPP_ENABLED", false);

  return {
    nodeEnv: str("NODE_ENV", "development"),
    isProduction: isProduction(),
    appUrl,
    appDomain: str("APP_DOMAIN"),
    appNameAr: str("APP_NAME_AR", "أفق"),
    appNameEn: str("APP_NAME_EN", "Ofoq"),
    defaultLocale: str("APP_DEFAULT_LOCALE", "ar") === "en" ? "en" : "ar",

    database: {
      driver: oneOf<DatabaseDriverName>(str("DATABASE_DRIVER", "sqlite"), ["sqlite", "postgres"], "sqlite"),
      sqlitePath: str("SQLITE_PATH", "./data/ofoq.sqlite"),
      url: str("DATABASE_URL"),
    },

    auth: {
      secret: authSecret || "ofoq-development-only-secret-do-not-use-in-production",
      sessionTtlHours: Math.max(1, num("AUTH_SESSION_TTL_HOURS", 168)),
      cookieSecure: bool("AUTH_COOKIE_SECURE", isProduction()),
      encryptionKey: str("APP_ENCRYPTION_KEY"),
      trustedOrigins: str("AUTH_TRUSTED_ORIGINS")
        .split(",")
        .map((origin) => origin.trim().replace(/\/$/, ""))
        .filter(Boolean),
    },

    google: {
      clientId: googleClientId,
      clientSecret: googleClientSecret,
      enabled: Boolean(googleClientId && googleClientSecret),
      redirectUri: `${appUrl}/api/auth/google/callback`,
    },

    ai: {
      provider: aiProvider,
      apiKey: aiApiKey,
      baseUrl: str("AI_BASE_URL", "https://api.openai.com/v1").replace(/\/$/, ""),
      model: str("AI_MODEL", "gpt-4o-mini"),
      temperature: num("AI_TEMPERATURE", 0.3),
      maxTokens: num("AI_MAX_TOKENS", 1200),
      timeoutMs: num("AI_TIMEOUT_MS", 30_000),
      enabled: aiProvider === "openai_compatible" && Boolean(aiApiKey),
    },

    gemini: {
      apiKey: str("GEMINI_API_KEY"),
      model: str("GEMINI_MODEL", "gemini-2.0-flash"),
      enabled: Boolean(str("GEMINI_API_KEY")),
    },

    email: {
      provider: emailProvider,
      from: str("EMAIL_FROM"),
      fromName: str("EMAIL_FROM_NAME", "أفق | Ofoq"),
      smtp: {
        host: smtpHost,
        port: num("SMTP_PORT", 587),
        user: str("SMTP_USER"),
        password: str("SMTP_PASSWORD"),
        secure: bool("SMTP_SECURE", false),
      },
      resendApiKey,
      live:
        (emailProvider === "smtp" && Boolean(smtpHost)) ||
        (emailProvider === "resend" && Boolean(resendApiKey)),
      ownerEmails: str("OWNER_EMAIL")
        .split(",")
        .map((address) => address.trim())
        .filter(Boolean),
    },

    payments: {
      provider: paymentsProvider,
      stripeSecretKey,
      stripeWebhookSecret: str("STRIPE_WEBHOOK_SECRET"),
      defaultCurrency: str("DEFAULT_CURRENCY", "USD").toUpperCase(),
      // Online card checkout stays off until a provider is genuinely available.
      onlineCheckoutEnabled: paymentsProvider === "stripe" && Boolean(stripeSecretKey),
    },

    googleAds: {
      enabled: googleAdsEnabled,
      apiVersion: str("GOOGLE_ADS_API_VERSION", "v18"),
      developerToken: str("GOOGLE_ADS_DEVELOPER_TOKEN"),
      clientId: str("GOOGLE_ADS_CLIENT_ID", googleClientId),
      clientSecret: str("GOOGLE_ADS_CLIENT_SECRET", googleClientSecret),
      refreshToken: str("GOOGLE_ADS_REFRESH_TOKEN"),
      loginCustomerId: str("GOOGLE_ADS_LOGIN_CUSTOMER_ID"),
      connected: false, // set from the integration record at runtime
    },

    whatsapp: {
      enabled: whatsappEnabled,
      provider: "meta_cloud",
      phoneNumberId: str("WHATSAPP_PHONE_NUMBER_ID"),
      accessToken: str("WHATSAPP_ACCESS_TOKEN"),
      verifyToken: str("WHATSAPP_VERIFY_TOKEN"),
      appSecret: str("WHATSAPP_APP_SECRET"),
      connected: false, // set from the integration record at runtime
    },

    cronSecret: str("CRON_SECRET"),
    dailyReportHour: Math.min(23, Math.max(0, num("DAILY_REPORT_HOUR", 7))),
    seedDemoData: bool("SEED_DEMO_DATA", false),
  };
}

/**
 * Production hardening checks. Returns human-readable warnings; the CLI
 * (`npm run db:status`) prints them and `/api/health` exposes a boolean.
 */
export function configWarnings(env: AppEnv = getEnv()): string[] {
  const warnings: string[] = [];
  if (!env.isProduction) return warnings;

  if (env.auth.secret.startsWith("ofoq-development-only")) {
    warnings.push("AUTH_SECRET is using the development default. Generate one with `openssl rand -base64 48`.");
  }
  if (env.auth.secret.length < 32) {
    warnings.push("AUTH_SECRET should be at least 32 characters long.");
  }
  if (!env.auth.encryptionKey) {
    warnings.push(
      "APP_ENCRYPTION_KEY is empty: third-party OAuth tokens (Google Ads/WhatsApp) cannot be stored encrypted, so those integrations stay disabled.",
    );
  }
  if (!env.auth.cookieSecure) {
    warnings.push("AUTH_COOKIE_SECURE is false in production; auth cookies should require HTTPS.");
  }
  if (env.database.driver === "sqlite" && !env.database.sqlitePath.includes("/")) {
    warnings.push("SQLITE_PATH has no directory component; make sure it is a persistent volume in production.");
  }
  if (!env.cronSecret) {
    warnings.push("CRON_SECRET is empty: /api/cron/* endpoints are disabled.");
  }
  if (env.ai.provider !== "none" && !env.ai.apiKey) {
    warnings.push(`AI_PROVIDER=${env.ai.provider} but AI_API_KEY is empty; the assistant falls back to the rules engine.`);
  }
  if (env.payments.provider === "stripe" && !env.payments.stripeSecretKey) {
    warnings.push("PAYMENTS_PROVIDER=stripe but STRIPE_SECRET_KEY is empty; only manual payments are available.");
  }
  if (env.seedDemoData) {
    warnings.push("SEED_DEMO_DATA=true in production: demo records must never be seeded in production.");
  }
  return warnings;
}

/**
 * Absolute path to the SQLite file.
 *
 * Relative values resolve from the current working directory, which is the
 * project root for `next dev`, `next start` and all npm scripts.
 */
export function sqliteFilePath(env: AppEnv = getEnv()): string {
  const configured = (env.database.sqlitePath || "./data/ofoq.sqlite").trim();
  const path = configured.length > 0 ? configured : "./data/ofoq.sqlite";
  if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) return path;
  return new URL(path.replace(/^\.\//, ""), `file://${process.cwd()}/`).pathname;
}
