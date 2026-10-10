/**
 * AI provider registry.
 *
 * Five chat providers are supported and every one of them speaks the
 * OpenAI-compatible `POST {baseUrl}/chat/completions` protocol, so one SDK
 * (`openai`) drives all of them — including Gemini, through Google's
 * OpenAI-compatibility endpoint.
 *
 * Hard rules kept here:
 *  1. No key is ever written in code. A provider declares the NAME of the
 *     environment variable that holds its key (`apiKeyEnv`); the value is read
 *     from `process.env` at call time.
 *  2. A missing key never throws: the provider simply reports "not configured"
 *     and the service moves on to the next one.
 *  3. Ordering is data, not code: `priority` (1 = tried first) plus the
 *     `arabicFirst` flag, which lets the assistant prefer the strongest Arabic
 *     model for Arabic messages without changing the default order.
 *  4. Model names are dated data too: `models[0]` is the model a provider is
 *     called with, and every following entry is a fallback the service tries on
 *     the SAME provider when the previous one is retired, rate limited or
 *     answers nothing. A provider listed here never depends on one model ID
 *     staying alive — vendor catalogues rotate these every few months.
 *
 * Model IDs last verified against the live catalogues (2026-10-10):
 *  - Groq:        https://console.groq.com/docs/models
 *                 https://console.groq.com/docs/deprecations (llama-3.1-8b-instant
 *                 and llama-3.3-70b-versatile were shut down on 2026-08-16)
 *  - Gemini:      https://ai.google.dev/gemini-api/docs/models
 *  - NVIDIA NIM:  https://integrate.api.nvidia.com/v1/models
 *                 (meta/llama-3.3-70b-instruct reached end of life 2026-05-26)
 *  - Cohere:      https://docs.cohere.com/docs/models
 *  - OpenRouter:  https://openrouter.ai/api/v1/models?max_price=0
 *                 (meta-llama/llama-3.3-70b-instruct:free has no serving
 *                 provider left; the paid slug is not a free-tier model)
 *
 * This module is pure and side-effect free: importing it must not read or log
 * any configuration.
 */

export type AiProviderId = "groq" | "gemini" | "nvidia" | "cohere" | "openrouter";

/** How a provider quota is expressed. */
export type AiLimitUnit = "day" | "month" | "minute";

export interface AiProviderConfig {
  id: AiProviderId;
  /** Display name (Latin — used in the "'بواسطة Groq'" style badge). */
  name: string;
  /** OpenAI-compatible API root, WITHOUT the trailing `/chat/completions`. */
  baseUrl: string;
  /** NAME of the environment variable holding the API key — never the key itself. */
  apiKeyEnv: string;
  /** 1 = tried first. Ties fall back to the order declared below. */
  priority: number;
  /**
   * Ordered model list; `models[0]` is the default for that provider and the
   * remaining entries are same-provider fallbacks, tried in order.
   */
  models: string[];
  /** Quota value for `limitUnit`. */
  dailyLimit: number;
  limitUnit: AiLimitUnit;
  /** True for the provider that produces the best Arabic output (Cohere). */
  arabicFirst?: boolean;
  /** Static, non-secret headers a provider asks clients to send. */
  defaultHeaders?: Record<string, string>;
  noteAr: string;
  noteEn: string;
}

/**
 * Declared in priority order: Groq (fastest), Gemini, NVIDIA NIM, Cohere (best
 * Arabic), OpenRouter (free-model safety net).
 */
export const AI_PROVIDERS: readonly AiProviderConfig[] = [
  {
    id: "groq",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    apiKeyEnv: "GROQ_API_KEY",
    priority: 1,
    // Llama 3.1 8B / 3.3 70B were retired on 2026-08-16; Groq's own replacement
    // guidance points at the gpt-oss family, which is what the free/base tier
    // (30 RPM, 1K RPD, 8K TPM per model) serves today.
    models: ["openai/gpt-oss-120b", "openai/gpt-oss-20b"],
    dailyLimit: 1_000,
    limitUnit: "day",
    noteAr: "الأسرع في الاستجابة — المزود الافتراضي.",
    noteEn: "Fastest first token — the default provider.",
  },
  {
    id: "gemini",
    name: "Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKeyEnv: "GEMINI_API_KEY",
    priority: 2,
    models: ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.5-pro"],
    dailyLimit: 1_500,
    limitUnit: "day",
    noteAr: "يُستدعى عبر وضع التوافق مع OpenAI (OpenAI compatibility mode).",
    noteEn: "Called through OpenAI compatibility mode.",
  },
  {
    id: "nvidia",
    name: "NVIDIA NIM",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    apiKeyEnv: "NVIDIA_API_KEY",
    priority: 3,
    // meta/llama-3.3-70b-instruct reached end of life on 2026-05-26, and the
    // suggested replacements (meta/llama-3.1-70b-instruct,
    // nvidia/llama-3.3-nemotron-super-49b-v1) are gone from the catalogue too.
    // Both IDs below are served by https://integrate.api.nvidia.com/v1/models.
    models: ["nvidia/nemotron-3-super-120b-a12b", "nvidia/nemotron-3.5-lightning-30b-a3b"],
    dailyLimit: 40,
    limitUnit: "minute",
    noteAr: "حد 40 طلبًا في الدقيقة.",
    noteEn: "Rate limited to 40 requests per minute.",
  },
  {
    id: "cohere",
    name: "Cohere",
    baseUrl: "https://api.cohere.ai/compatibility/v1",
    apiKeyEnv: "COHERE_API_KEY",
    priority: 4,
    models: ["command-r7b-arabic-02-2025", "command-r-plus-08-2024"],
    dailyLimit: 1_000,
    limitUnit: "month",
    arabicFirst: true,
    noteAr: "الأفضل في اللغة العربية — يُقدَّم تلقائيًا للرسائل العربية.",
    noteEn: "Best Arabic output — promoted automatically for Arabic messages.",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    priority: 5,
    // meta-llama/llama-3.3-70b-instruct:free no longer has a single serving
    // provider (the live slug without `:free` is a PAID model, so it would break
    // the free-tier rule). These two `:free` slugs are served today, support
    // temperature/max_tokens/response_format, and answer directly rather than
    // spending the token budget on reasoning.
    models: ["google/gemma-4-31b-it:free", "google/gemma-4-26b-a4b-it:free"],
    dailyLimit: 50,
    limitUnit: "day",
    defaultHeaders: { "X-Title": "Ofoq" },
    noteAr: "خط أخير بموديلات مجانية.",
    noteEn: "A final safety net using free models.",
  },
] as const;

/** Provider ids, for validation in routes and tests. */
export const AI_PROVIDER_IDS: readonly AiProviderId[] = AI_PROVIDERS.map((provider) => provider.id);

/** Human-readable names for badges, including the local rules engine. */
export const AI_PROVIDER_LABELS: Record<string, { ar: string; en: string }> = {
  groq: { ar: "Groq", en: "Groq" },
  gemini: { ar: "Gemini", en: "Gemini" },
  nvidia: { ar: "NVIDIA NIM", en: "NVIDIA NIM" },
  cohere: { ar: "Cohere", en: "Cohere" },
  openrouter: { ar: "OpenRouter", en: "OpenRouter" },
  rules: { ar: "القواعد المحلية", en: "local rules" },
};

/** Display name for a provider id; unknown ids are returned unchanged. */
export function providerLabel(id: string, locale: "ar" | "en" = "ar"): string {
  const label = AI_PROVIDER_LABELS[id];
  if (label) return label[locale];
  const provider = getAiProvider(id);
  return provider ? provider.name : id;
}

export function getAiProvider(id: string | null | undefined): AiProviderConfig | null {
  if (!id) return null;
  return AI_PROVIDERS.find((provider) => provider.id === id) ?? null;
}

/** Providers in the order they should be attempted (priority ascending). */
export function providersByPriority(): AiProviderConfig[] {
  return [...AI_PROVIDERS].sort((a, b) => a.priority - b.priority);
}

/** Values that mean "no key was supplied", even though the variable exists. */
const BLANK_KEY_VALUES = new Set(["undefined", "null", "none", "false", "change-me", "changeme", "replace-me"]);

/**
 * Reads a provider key from the environment.
 *
 * Returns "" when the variable is missing or blank, so callers can treat
 * "not configured" as an ordinary state. The value is never logged.
 */
export function providerApiKey(provider: AiProviderConfig): string {
  return (process.env[provider.apiKeyEnv] ?? "").trim();
}

/**
 * True when the provider's key is present in the environment.
 *
 * Accepts a provider object or a provider id; unknown ids are never configured.
 */
export function isConfigured(provider: AiProviderConfig | string | null | undefined): boolean {
  const resolved = typeof provider === "string" ? getAiProvider(provider) : provider;
  if (!resolved) return false;
  const key = providerApiKey(resolved);
  return key.length > 0 && !BLANK_KEY_VALUES.has(key.toLowerCase());
}

/** Configured providers, in priority order. */
export function configuredProviders(): AiProviderConfig[] {
  return providersByPriority().filter((provider) => isConfigured(provider));
}

/** The provider that will be tried first, or null when no key exists at all. */
export function firstConfiguredProvider(): AiProviderConfig | null {
  return configuredProviders()[0] ?? null;
}

export function anyProviderConfigured(): boolean {
  return configuredProviders().length > 0;
}

/**
 * Status list for the owner integrations screen.
 * Contains variable NAMES and metadata only — never key material.
 */
export interface AiProviderStatus {
  id: AiProviderId;
  name: string;
  apiKeyEnv: string;
  configured: boolean;
  priority: number;
  models: string[];
  activeModel: string;
  dailyLimit: number;
  limitUnit: AiLimitUnit;
  arabicFirst: boolean;
  noteAr: string;
  noteEn: string;
}

export function providerStatuses(): AiProviderStatus[] {
  return providersByPriority().map((provider) => ({
    id: provider.id,
    name: provider.name,
    apiKeyEnv: provider.apiKeyEnv,
    configured: isConfigured(provider),
    priority: provider.priority,
    models: [...provider.models],
    activeModel: provider.models[0] ?? "",
    dailyLimit: provider.dailyLimit,
    limitUnit: provider.limitUnit,
    arabicFirst: Boolean(provider.arabicFirst),
    noteAr: provider.noteAr,
    noteEn: provider.noteEn,
  }));
}
