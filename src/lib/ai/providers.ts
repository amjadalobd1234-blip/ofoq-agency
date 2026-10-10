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
 *  5. Only models that a FREE key can actually call are listed. `modelRoles`
 *     then says which of those to prefer for a kind of request (Arabic, fastest,
 *     most accurate) without changing the fallback order.
 *
 * Model IDs last verified against the live catalogues (2026-10-11):
 *  - Groq:        https://console.groq.com/docs/models
 *                 https://console.groq.com/docs/rate-limits (the three chat
 *                 models below are the ones a normal key can call; both Llama
 *                 chat models are Enterprise-only and were retired 2026-08-16)
 *  - Gemini:      https://ai.google.dev/gemini-api/docs/models
 *  - NVIDIA NIM:  https://integrate.api.nvidia.com/v1/models plus the model page
 *                 at https://build.nvidia.com/<id> — pages WITHOUT a
 *                 "Serverless (per 1M tokens) $…" price are on the free trial
 *                 (1,000 credits/month, 40 RPM). Priced pages (for example
 *                 nvidia/nemotron-3-super-120b-a12b and moonshotai/kimi-k3) and
 *                 404 pages (mistralai/mistral-7b-instruct-v0.3, z-ai/glm-5.3)
 *                 are excluded on purpose.
 *  - Cohere:      https://docs.cohere.com/docs/models
 *  - OpenRouter:  https://openrouter.ai/api/v1/models?max_price=0 — only slugs
 *                 that still have serving providers. meta-llama/llama-3.3-70b-instruct:free
 *                 and meta-llama/llama-3.2-3b-instruct:free now return an empty
 *                 endpoint list, and the slug without `:free` is a PAID model.
 *
 * Re-check this file whenever a provider answers "model does not exist",
 * "end of life" or "payment required": vendor catalogues move faster than code.
 *
 * This module is pure and side-effect free: importing it must not read or log
 * any configuration.
 */

export type AiProviderId = "groq" | "gemini" | "nvidia" | "cohere" | "openrouter";

/** A kind of request the assistant serves, used to pick the best free model. */
export type AiModelPreference = "arabic" | "fast" | "accurate";

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
  /**
   * Optional per-request-kind hints, every value drawn from `models`.
   *
   * A hint only reorders that provider's models for one request (the Arabic
   * model for an Arabic message, the small model when speed matters, the large
   * one when quality does); the full fallback list is still tried afterwards.
   */
  modelRoles?: Partial<Record<AiModelPreference, string>>;
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
    // What a normal (free) Groq key can call, per the rate-limits page:
    // gpt-oss-120b, gpt-oss-20b and qwen3.8-27b at 30 RPM / 1K RPD / 8K TPM.
    // Both Llama chat models are Enterprise-only and were retired 2026-08-16;
    // mixtral-8x7b-32768 (2025-03-20) and gemma2-9b-it (2025-10-08) are long gone.
    models: ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.8-27b"],
    modelRoles: {
      // Qwen is the multilingual member of the trio; gpt-oss answers in Arabic
      // but with weaker wording.
      arabic: "qwen/qwen3.8-27b",
      fast: "openai/gpt-oss-20b",
      accurate: "openai/gpt-oss-120b",
    },
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
    // Free-trial endpoints only (no "Serverless (per 1M tokens)" price on their
    // build page). meta/llama-3.3-70b-instruct (end of life 2026-05-26),
    // meta/llama-3.1-8b-instruct (not in the catalogue) and
    // mistralai/mistral-7b-instruct-v0.3 (404 build page) are excluded, as are
    // the paid nemotron-3-super-120b-a12b and kimi-k3 endpoints.
    models: [
      "google/gemma-4-31b-it",
      "nvidia/nemotron-3.5-lightning-30b-a3b",
      "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
    ],
    modelRoles: {
      // Gemma 4 is the multilingual one; Nemotron is NVIDIA's own, and much faster.
      arabic: "google/gemma-4-31b-it",
      fast: "nvidia/nemotron-3.5-lightning-30b-a3b",
      accurate: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
    },
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
    // From https://openrouter.ai/api/v1/models?max_price=0 (18 served slugs).
    // llama-3.3-70b-instruct:free and llama-3.2-3b-instruct:free come back with an
    // empty endpoint list, and every slug without `:free` is a paid model.
    models: [
      "google/gemma-4-31b-it:free",
      "google/gemma-4-26b-a4b-it:free",
      "nvidia/nemotron-3-super-120b-a12b:free",
    ],
    modelRoles: {
      // Gemma 4 covers 140+ languages; the 26B-A4B build is the small, fast one.
      arabic: "google/gemma-4-31b-it:free",
      fast: "google/gemma-4-26b-a4b-it:free",
      accurate: "nvidia/nemotron-3-super-120b-a12b:free",
    },
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
