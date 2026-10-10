/**
 * Multi-provider AI service.
 *
 * One entry point — `chat()` — that:
 *   1. picks providers by priority (Groq first),
 *   2. prefers Cohere automatically when the conversation is Arabic, and asks
 *      each provider for its Arabic / fastest / most accurate free model when
 *      the request hints at one (`options.prefer`, or Arabic script detected),
 *   3. inside a provider, falls back to the next declared model before giving up
 *      on that provider — so a retired model ID (404 "model does not exist",
 *      end-of-life, a withdrawn `:free` slug) costs one attempt, not a provider,
 *   4. falls back to the next provider on rate limits (429), timeouts (>30s),
 *      5xx/4xx errors, network failures and missing keys,
 *   5. records one usage row per attempt through the caller's sink,
 *   6. returns `{ text, provider, model, usage }` — and only throws when every
 *      provider failed, so callers can fall back to the local rules engine.
 *
 * All five providers (Groq, Gemini over its OpenAI-compatibility endpoint,
 * NVIDIA NIM, Cohere, OpenRouter) are called with the official `openai` SDK and
 * a per-provider `baseURL`. No key is ever read from code: only from
 * `process.env[provider.apiKeyEnv]`.
 */
import OpenAI from "openai";

import { logger } from "@/lib/core/logger";
import {
  getAiProvider,
  providerApiKey,
  providersByPriority,
  type AiModelPreference,
  type AiProviderConfig,
  type AiProviderId,
} from "@/lib/ai/providers";
import {
  createUsageEntry,
  type AiUsageEntry,
  type AiUsageSink,
  type AiUsageStatus,
} from "@/lib/ai/usage";

/** Arabic script range. Used to route Arabic conversations to the best model. */
export const ARABIC_PATTERN = /[\u0600-\u06FF]/;

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_TEMPERATURE = 0.3;
export const DEFAULT_MAX_TOKENS = 700;

export interface AiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AiChatOptions {
  /** Internal agent asking for the completion (stored in `ai_usage.agent_key`). */
  agentKey?: string | null;
  /** Client this completion belongs to (stored in `ai_usage.customer_id`). */
  customerId?: string | null;
  temperature?: number;
  maxTokens?: number;
  /** Per-provider timeout. Defaults to 30s, clamped to 1s…120s. */
  timeoutMs?: number;
  /** Force one provider to be attempted first (used by the "test" button). */
  providerId?: AiProviderId | string;
  /** Overrides the model for the provider that is attempted. */
  model?: string;
  /**
   * Which provider model to try first: the Arabic-friendly one, the fastest one
   * or the most accurate one. Defaults to "arabic" automatically when any
   * message contains Arabic script. The provider's remaining models stay in the
   * fallback chain either way.
   */
  prefer?: AiModelPreference;
  /** Ask for a JSON object response where the provider supports it. */
  json?: boolean;
  /** Usage sink. Defaults to a structured log line. */
  onUsage?: AiUsageSink;
}

export interface AiAttempt {
  provider: string;
  model: string;
  status: AiUsageStatus;
  durationMs: number;
  error?: string;
}

export interface AiChatResult {
  text: string;
  provider: string;
  model: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    durationMs: number;
  };
  /** One entry per provider that was attempted (successes and failures). */
  attempts: AiAttempt[];
}

/**
 * Thrown when no provider could produce text.
 *
 * `reason` distinguishes "nothing is configured" from "everything failed", so
 * the API can answer 503 (setup problem) versus 502 (upstream problem) and the
 * assistant can fall back to its local rules.
 */
export class AiUnavailableError extends Error {
  readonly reason: "no_provider" | "all_failed";
  readonly attempts: AiAttempt[];

  constructor(reason: "no_provider" | "all_failed", attempts: AiAttempt[], message?: string) {
    super(
      message ??
        (reason === "no_provider"
          ? "No AI provider is configured. Add at least one provider key."
          : "Every AI provider failed. The local rules engine will be used instead."),
    );
    this.name = "AiUnavailableError";
    this.reason = reason;
    this.attempts = attempts;
  }
}

export function isArabicText(text: string | null | undefined): boolean {
  return typeof text === "string" && ARABIC_PATTERN.test(text);
}

export function messagesContainArabic(messages: AiMessage[]): boolean {
  return messages.some((message) => isArabicText(message.content));
}

/**
 * Providers in the order they will be attempted for these messages.
 *
 * - Default: priority order (Groq → Gemini → NVIDIA → Cohere → OpenRouter).
 * - Arabic detected: the Arabic-optimised provider (Cohere) goes first, then the
 *   remaining providers keep their priority.
 * - `options.providerId`: that provider goes first (diagnostics only).
 */
export function providerOrder(
  messages: AiMessage[],
  options: Pick<AiChatOptions, "providerId"> = {},
): AiProviderConfig[] {
  const base = providersByPriority();
  const forced = getAiProvider(options.providerId ?? null);
  if (forced) return [forced, ...base.filter((provider) => provider.id !== forced.id)];

  if (messagesContainArabic(messages)) {
    const arabicFirst = base.find((provider) => provider.arabicFirst);
    if (arabicFirst) {
      return [arabicFirst, ...base.filter((provider) => provider.id !== arabicFirst.id)];
    }
  }
  return base;
}

function clampTimeout(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.min(120_000, Math.max(1_000, Math.trunc(value as number)));
}

/** Keeps a caller-supplied model safe to put in a request body. */
function sanitiseModel(candidate: string | undefined): string | null {
  const value = candidate?.trim();
  if (value && /^[A-Za-z0-9._:/@-]{1,120}$/.test(value)) return value;
  return null;
}

/**
 * Models to try for one provider, in order.
 *
 *   1. an explicit `options.model` — the caller wins;
 *   2. the provider's model for `options.prefer` (arabic / fast / accurate);
 *   3. the declared list — `models[0]` is the default, the rest are fallbacks.
 *
 * Duplicates are dropped, and a provider with no declared model still yields one
 * empty entry so the SDK produces a clear vendor error instead of a crash.
 */
export function providerModels(
  provider: AiProviderConfig,
  options: Pick<AiChatOptions, "model" | "prefer"> = {},
): string[] {
  const requested = sanitiseModel(options.model);
  const preferred = options.prefer ? sanitiseModel(provider.modelRoles?.[options.prefer]) : null;
  const declared = (Array.isArray(provider.models) ? provider.models : []).filter(
    (model) => typeof model === "string" && model.trim().length > 0,
  );

  const ordered: string[] = [];
  for (const model of [requested, preferred, ...declared]) {
    if (model && !ordered.includes(model)) ordered.push(model);
  }
  return ordered.length > 0 ? ordered : [""];
}

/** The preference a request implies: an explicit hint, else Arabic detection. */
export function requestPreference(
  messages: AiMessage[],
  options: Pick<AiChatOptions, "prefer"> = {},
): AiModelPreference | undefined {
  if (options.prefer) return options.prefer;
  return messagesContainArabic(messages) ? "arabic" : undefined;
}

function normaliseMessages(messages: AiMessage[]): AiMessage[] {
  const cleaned = (Array.isArray(messages) ? messages : [])
    .map((message) => ({
      role: message?.role,
      content: typeof message?.content === "string" ? message.content.trim() : "",
    }))
    .filter((message): message is AiMessage =>
      (message.role === "system" || message.role === "user" || message.role === "assistant") &&
      message.content.length > 0,
    )
    .slice(-60)
    .map((message) => ({ role: message.role, content: message.content.slice(0, 12_000) }));

  if (cleaned.length === 0) {
    throw new Error("AI request must contain at least one non-empty message.");
  }
  return cleaned;
}

function toApiMessages(messages: AiMessage[]): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return messages.map((message) => {
    if (message.role === "system") return { role: "system", content: message.content };
    if (message.role === "assistant") return { role: "assistant", content: message.content };
    return { role: "user", content: message.content };
  });
}

function describeError(error: unknown): {
  status: AiUsageStatus;
  error: string;
  aborted: boolean;
  /** HTTP status when the failure came back from the provider, else undefined. */
  httpStatus?: number;
} {
  const message = error instanceof Error ? error.message : String(error);

  if (error instanceof OpenAI.APIUserAbortError) {
    return { status: "TIMEOUT", error: "Request cancelled by the caller.", aborted: true };
  }
  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    return { status: "TIMEOUT", error: message, aborted: false };
  }
  if (error instanceof OpenAI.RateLimitError) {
    return { status: "RATE_LIMIT", error: message, aborted: false, httpStatus: error.status ?? 429 };
  }
  if (error instanceof OpenAI.APIError) {
    const status = error.status ?? 0;
    return {
      status: status === 429 ? "RATE_LIMIT" : "PROVIDER_ERROR",
      error: `HTTP ${status}${message ? `: ${message}` : ""}`,
      aborted: false,
      httpStatus: status,
    };
  }
  if (error instanceof Error && (error.name === "AbortError" || /timed? ?out/i.test(message))) {
    return { status: "TIMEOUT", error: message, aborted: false };
  }
  return { status: "PROVIDER_ERROR", error: message, aborted: false };
}

/**
 * True when the next model of the SAME provider would fail the same way, so the
 * chain should move straight to the next provider instead of spending attempts.
 *
 *  - 401/403: the key is wrong for every model of that provider.
 *  - TIMEOUT: the provider is slow right now; another model on it is unlikely to
 *    be faster, and re-trying would double the worst-case latency of a request
 *    (and of the "test provider" button).
 *
 * Everything else — 404 retired model, 400, 429, 5xx, empty answer — gets the
 * provider's fallback model.
 */
function skipRemainingModels(error: { status: AiUsageStatus; httpStatus?: number }): boolean {
  if (error.httpStatus === 401 || error.httpStatus === 403) return true;
  return error.status === "TIMEOUT";
}

interface ProviderCallResult {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** HTTP 200 but no usable text: keep trying with the next provider. */
  empty: boolean;
}

async function callProvider(
  provider: AiProviderConfig,
  apiKey: string,
  messages: AiMessage[],
  options: AiChatOptions,
  timeoutMs: number,
  model: string,
): Promise<ProviderCallResult> {
  const client = new OpenAI({
    apiKey,
    baseURL: provider.baseUrl,
    timeout: timeoutMs,
    // The service owns the fallback chain: never let the SDK retry silently.
    maxRetries: 0,
    ...(provider.defaultHeaders ? { defaultHeaders: provider.defaultHeaders } : {}),
  });

  const completion = await client.chat.completions.create({
    model,
    messages: toApiMessages(messages),
    temperature: options.temperature ?? DEFAULT_TEMPERATURE,
    max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...(options.json ? { response_format: { type: "json_object" as const } } : {}),
  });

  const text = (completion.choices?.[0]?.message?.content ?? "").trim();
  return {
    text,
    model: completion.model || model,
    inputTokens: completion.usage?.prompt_tokens ?? 0,
    outputTokens: completion.usage?.completion_tokens ?? 0,
    empty: text.length === 0,
  };
}

/**
 * Sends a chat completion through the provider chain.
 *
 * @throws {AiUnavailableError} when no provider is configured or all failed.
 */
export async function chat(messages: AiMessage[], options: AiChatOptions = {}): Promise<AiChatResult> {
  const normalised = normaliseMessages(messages);
  const order = providerOrder(normalised, options);
  const prefer = requestPreference(normalised, options);
  const timeoutMs = clampTimeout(options.timeoutMs);
  const onUsage = options.onUsage;
  const attempts: AiAttempt[] = [];
  const startedAt = Date.now();

  let anyConfigured = false;
  let cancelled = false;

  for (const provider of order) {
    if (cancelled) break;

    const apiKey = providerApiKey(provider);
    // The model this request prefers first, then that provider's fallbacks (a
    // retired model ID must not cost the whole provider).
    const models = providerModels(provider, { model: options.model, prefer });

    if (!apiKey) {
      const attempt: AiAttempt = {
        provider: provider.id,
        model: models[0] ?? "",
        status: "MISSING_KEY",
        durationMs: 0,
      };
      attempts.push(attempt);
      await record(onUsage, { attempt, options });
      continue;
    }
    anyConfigured = true;

    for (const [index, model] of models.entries()) {
      const attemptStarted = Date.now();
      try {
        const result = await callProvider(provider, apiKey, normalised, options, timeoutMs, model);
        const durationMs = Date.now() - attemptStarted;

        if (result.empty) {
          const attempt: AiAttempt = {
            provider: provider.id,
            model: result.model,
            status: "EMPTY_RESPONSE",
            durationMs,
            error: "Provider returned an empty message.",
          };
          attempts.push(attempt);
          await record(onUsage, {
            attempt,
            options,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
          });
          continue;
        }

        const attempt: AiAttempt = {
          provider: provider.id,
          model: result.model,
          status: "OK",
          durationMs,
        };
        attempts.push(attempt);
        await record(onUsage, {
          attempt,
          options,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        });

        return {
          text: result.text,
          provider: provider.id,
          model: result.model,
          usage: {
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            totalTokens: result.inputTokens + result.outputTokens,
            durationMs,
          },
          attempts,
        };
      } catch (error) {
        const failure = describeError(error);
        const attempt: AiAttempt = {
          provider: provider.id,
          model,
          status: failure.status,
          durationMs: Date.now() - attemptStarted,
          error: failure.error.slice(0, 300),
        };
        attempts.push(attempt);
        await record(onUsage, { attempt, options });

        // A caller-side cancellation is not a provider problem: stop the chain.
        if (failure.aborted) {
          cancelled = true;
          break;
        }

        const more = index < models.length - 1;
        logger.warn(
          more ? "AI model failed; trying the provider's fallback model" : "AI provider failed; trying the next one",
          {
            provider: provider.id,
            model,
            status: failure.status,
            error: failure.error,
          },
        );

        if (skipRemainingModels(failure)) break;
      }
    }
  }

  const finalStatus: AiAttempt = {
    provider: "none",
    model: "",
    status: "UNAVAILABLE",
    durationMs: Date.now() - startedAt,
  };
  attempts.push(finalStatus);
  await record(onUsage, {
    attempt: finalStatus,
    options,
    error: anyConfigured ? "All providers failed." : "No provider key is configured.",
  });

  throw new AiUnavailableError(anyConfigured ? "all_failed" : "no_provider", attempts);
}

/** Writes one usage entry, with every optional field defaulted. */
async function record(
  sink: AiUsageSink | undefined,
  input: {
    attempt: AiAttempt;
    options: AiChatOptions;
    inputTokens?: number;
    outputTokens?: number;
    error?: string;
  },
): Promise<void> {
  if (!sink) return;
  const entry: AiUsageEntry = createUsageEntry({
    provider: input.attempt.provider,
    model: input.attempt.model,
    agentKey: input.options.agentKey ?? null,
    customerId: input.options.customerId ?? null,
    inputTokens: input.inputTokens ?? 0,
    outputTokens: input.outputTokens ?? 0,
    status: input.attempt.status,
    durationMs: input.attempt.durationMs,
    error: input.error ?? input.attempt.error,
  });
  try {
    await sink(entry);
  } catch (error) {
    // A broken sink must never break a client reply.
    logger.warn("AI usage sink threw", {
      provider: entry.provider,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
