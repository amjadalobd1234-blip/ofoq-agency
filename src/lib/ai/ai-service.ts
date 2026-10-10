/**
 * Multi-provider AI service.
 *
 * One entry point — `chat()` — that:
 *   1. picks providers by priority (Groq first),
 *   2. prefers Cohere automatically when the conversation is Arabic,
 *   3. falls back to the next provider on rate limits (429), timeouts (>30s),
 *      5xx/4xx errors, network failures and missing keys,
 *   4. records one usage row per attempt through the caller's sink,
 *   5. returns `{ text, provider, model, usage }` — and only throws when every
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
function resolveModel(provider: AiProviderConfig, options: AiChatOptions): string {
  const candidate = options.model?.trim();
  if (candidate && /^[A-Za-z0-9._:/@-]{1,120}$/.test(candidate)) return candidate;
  return provider.models[0] ?? "";
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

function describeError(error: unknown): { status: AiUsageStatus; error: string; aborted: boolean } {
  const message = error instanceof Error ? error.message : String(error);

  if (error instanceof OpenAI.APIUserAbortError) {
    return { status: "TIMEOUT", error: "Request cancelled by the caller.", aborted: true };
  }
  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    return { status: "TIMEOUT", error: message, aborted: false };
  }
  if (error instanceof OpenAI.RateLimitError) {
    return { status: "RATE_LIMIT", error: message, aborted: false };
  }
  if (error instanceof OpenAI.APIError) {
    const status = error.status ?? 0;
    return {
      status: status === 429 ? "RATE_LIMIT" : "PROVIDER_ERROR",
      error: `HTTP ${status}${message ? `: ${message}` : ""}`,
      aborted: false,
    };
  }
  if (error instanceof Error && (error.name === "AbortError" || /timed? ?out/i.test(message))) {
    return { status: "TIMEOUT", error: message, aborted: false };
  }
  return { status: "PROVIDER_ERROR", error: message, aborted: false };
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
): Promise<ProviderCallResult> {
  const model = resolveModel(provider, options);
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
  const timeoutMs = clampTimeout(options.timeoutMs);
  const onUsage = options.onUsage;
  const attempts: AiAttempt[] = [];
  const startedAt = Date.now();

  let anyConfigured = false;

  for (const provider of order) {
    const model = resolveModel(provider, options);
    const apiKey = providerApiKey(provider);

    if (!apiKey) {
      const attempt: AiAttempt = { provider: provider.id, model, status: "MISSING_KEY", durationMs: 0 };
      attempts.push(attempt);
      await record(onUsage, { attempt, options });
      continue;
    }
    anyConfigured = true;

    const attemptStarted = Date.now();
    try {
      const result = await callProvider(provider, apiKey, normalised, options, timeoutMs);
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
      const { status, error: detail, aborted } = describeError(error);
      const attempt: AiAttempt = {
        provider: provider.id,
        model,
        status,
        durationMs: Date.now() - attemptStarted,
        error: detail.slice(0, 300),
      };
      attempts.push(attempt);
      await record(onUsage, { attempt, options });

      logger.warn("AI provider failed; trying the next one", {
        provider: provider.id,
        model,
        status,
        error: detail,
      });

      // A caller-side cancellation is not a provider problem: stop the chain.
      if (aborted) break;
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
