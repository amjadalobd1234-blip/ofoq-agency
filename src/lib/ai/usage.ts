/**
 * AI usage accounting.
 *
 * Every provider attempt (successful or not) produces one `AiUsageEntry`. The
 * service never talks to a database itself: it hands the entry to a sink the
 * caller provides. That keeps `ai-service` testable and usable from the
 * assistant, an agent, or a one-off script.
 *
 * The Supabase sink used by the API routes stores rows in `public.ai_usage`
 * through the `ofoq_ai_usage_record` RPC (see
 * `db/migrations/supabase/0002_ai_usage.sql`). A sink must never throw: a
 * logging failure must not break a client reply.
 */
import { logger } from "@/lib/core/logger";

export type AiUsageStatus =
  /** The provider answered and its text was used. */
  | "OK"
  /** HTTP 429 or a provider-reported quota. */
  | "RATE_LIMIT"
  /** No answer inside the configured timeout. */
  | "TIMEOUT"
  /** 5xx, 401/403/404, network failure, or an unusable payload. */
  | "PROVIDER_ERROR"
  /** The provider was skipped because its key is not in the environment. */
  | "MISSING_KEY"
  /** HTTP 200 with empty text. */
  | "EMPTY_RESPONSE"
  /** Every provider failed, so no AI text was produced at all. */
  | "UNAVAILABLE";

export interface AiUsageEntry {
  id: string;
  provider: string;
  model: string;
  /** Internal agent that asked for the completion, when known. */
  agentKey: string | null;
  /** Client this completion belongs to, when known. */
  customerId: string | null;
  inputTokens: number;
  outputTokens: number;
  status: AiUsageStatus;
  durationMs: number;
  /** ISO-8601 UTC timestamp, stored as TEXT in the database. */
  createdAt: string;
  /** Short, non-sensitive reason for a failure (never contains the key). */
  error?: string;
}

export type AiUsageSink = (entry: AiUsageEntry) => void | Promise<void>;

/** Statuses that produced usable text. */
export function isSuccessStatus(status: AiUsageStatus): boolean {
  return status === "OK";
}

/** Opaque id for a usage row (Web Crypto first, so it also works on workers). */
export function newUsageId(): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  const random = Math.random().toString(36).slice(2, 12);
  return `aiu_${Date.now().toString(36)}_${random}`;
}

export function createUsageEntry(
  input: Partial<AiUsageEntry> & Pick<AiUsageEntry, "provider" | "model" | "status">,
): AiUsageEntry {
  return {
    id: input.id ?? newUsageId(),
    provider: input.provider,
    model: input.model,
    agentKey: input.agentKey ?? null,
    customerId: input.customerId ?? null,
    inputTokens: Math.max(0, Math.trunc(input.inputTokens ?? 0)),
    outputTokens: Math.max(0, Math.trunc(input.outputTokens ?? 0)),
    status: input.status,
    durationMs: Math.max(0, Math.trunc(input.durationMs ?? 0)),
    createdAt: input.createdAt ?? new Date().toISOString(),
    ...(input.error ? { error: input.error.slice(0, 300) } : {}),
  };
}

/**
 * Wraps any recorder (a Supabase RPC call, a queue push, a test spy) in a sink
 * that can never break the AI call it is observing.
 */
export function safeUsageSink(record: (entry: AiUsageEntry) => unknown): AiUsageSink {
  return async (entry) => {
    try {
      await record(entry);
    } catch (error) {
      logger.warn("AI usage could not be recorded", {
        provider: entry.provider,
        status: entry.status,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

/** Default sink: structured log line only (used when no database is wired). */
export function loggingUsageSink(): AiUsageSink {
  return (entry) => {
    logger.info("AI usage", {
      provider: entry.provider,
      model: entry.model,
      status: entry.status,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      durationMs: entry.durationMs,
      agentKey: entry.agentKey,
    });
  };
}

/**
 * Arguments for the `ofoq_ai_usage_record` RPC.
 * Kept in one place so the SQL function signature and the TypeScript caller
 * cannot drift apart.
 */
export function aiUsageRpcArgs(entry: AiUsageEntry): Record<string, unknown> {
  return {
    p_id: entry.id,
    p_provider: entry.provider,
    p_model: entry.model,
    p_agent_key: entry.agentKey,
    p_customer_id: entry.customerId,
    p_input_tokens: entry.inputTokens,
    p_output_tokens: entry.outputTokens,
    p_status: entry.status,
    p_duration_ms: entry.durationMs,
  };
}
