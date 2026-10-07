import { getEnv } from "@/lib/config/env";
import { IntegrationDisabledError } from "@/lib/core/errors";
import { logger } from "@/lib/core/logger";

/**
 * AI model provider abstraction.
 *
 * The platform NEVER requires an external AI account to function:
 *   AI_PROVIDER=none              → `available()` is false and callers use the
 *                                   built-in deterministic rules engine.
 *   AI_PROVIDER=openai_compatible → any OpenAI-compatible chat-completions
 *                                   endpoint (OpenAI, Azure, OpenRouter, Groq,
 *                                   local vLLM/Ollama…). Configured purely from
 *                                   the environment; no vendor SDK is bundled.
 *
 * Everything that talks to a model goes through this module so provider, model,
 * temperature, cost accounting and timeouts are configured in one place.
 */
export interface AiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AiCompletionRequest {
  messages: AiMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Requests a JSON object response where the provider supports it. */
  json?: boolean;
}

export interface AiCompletionResult {
  text: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
}

export interface AiStatus {
  provider: string;
  model: string;
  available: boolean;
  reason?: string;
}

export function aiStatus(): AiStatus {
  const env = getEnv();
  if (env.ai.provider === "none") {
    return {
      provider: "none",
      model: "rules-engine",
      available: false,
      reason:
        "No AI provider is configured. The platform is running on the built-in deterministic rules engine.",
    };
  }
  if (!env.ai.apiKey) {
    return {
      provider: env.ai.provider,
      model: env.ai.model,
      available: false,
      reason: `AI_PROVIDER=${env.ai.provider} requires AI_API_KEY.`,
    };
  }
  return { provider: env.ai.provider, model: env.ai.model, available: true };
}

export function aiAvailable(): boolean {
  return aiStatus().available;
}

export async function aiComplete(request: AiCompletionRequest): Promise<AiCompletionResult> {
  const status = aiStatus();
  if (!status.available) {
    throw new IntegrationDisabledError("ai", status.reason ?? "AI provider is not configured", {
      provider: status.provider,
    });
  }
  const env = getEnv();
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.ai.timeoutMs);

  try {
    const response = await fetch(`${env.ai.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.ai.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: env.ai.model,
        messages: request.messages,
        temperature: request.temperature ?? env.ai.temperature,
        max_tokens: request.maxTokens ?? env.ai.maxTokens,
        ...(request.json ? { response_format: { type: "json_object" } } : {}),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`AI provider returned ${response.status}: ${detail.slice(0, 300)}`);
    }

    const payload = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = payload.choices?.[0]?.message?.content?.trim() ?? "";
    if (!text) throw new Error("AI provider returned an empty response");

    return {
      text,
      provider: env.ai.provider,
      model: env.ai.model,
      promptTokens: payload.usage?.prompt_tokens ?? 0,
      completionTokens: payload.usage?.completion_tokens ?? 0,
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    logger.error("AI completion failed", {
      provider: env.ai.provider,
      model: env.ai.model,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Asks the model for a JSON object and parses it defensively.
 * Returns `null` when the provider is unavailable or the answer is not usable,
 * so every caller can fall back to the rules engine instead of failing.
 */
export async function aiCompleteJson<T>(request: AiCompletionRequest): Promise<T | null> {
  if (!aiAvailable()) return null;
  try {
    const result = await aiComplete({ ...request, json: true });
    const cleaned = result.text
      .replace(/^```(?:json)?/i, "")
      .replace(/```$/, "")
      .trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1) return null;
    return JSON.parse(cleaned.slice(start, end + 1)) as T;
  } catch (error) {
    logger.warn("Falling back to the rules engine: AI JSON completion unusable", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** Wording polish helper: returns the original text when no model is available. */
export async function aiRewrite(
  text: string,
  instruction: string,
  options: { locale?: string } = {},
): Promise<string> {
  if (!aiAvailable()) return text;
  try {
    const result = await aiComplete({
      messages: [
        {
          role: "system",
          content:
            "You are an editor for a digital marketing agency platform. " +
            "Rewrite the given text following the instruction. Keep every fact, number and name unchanged. " +
            "Never promise results that are not in the text. Reply with the rewritten text only." +
            (options.locale === "ar"
              ? " Use clear, friendly Modern Standard Arabic with no regional dialect."
              : ""),
        },
        { role: "user", content: `Instruction: ${instruction}\n\nText:\n${text}` },
      ],
      temperature: 0.4,
    });
    return result.text;
  } catch {
    return text;
  }
}

/** Records a model call against the AI provider budget for the dashboards. */
export function describeProviderUsage(result: AiCompletionResult): string {
  return `${result.provider}:${result.model} (${result.promptTokens}+${result.completionTokens} tokens, ${result.latencyMs}ms)`;
}
