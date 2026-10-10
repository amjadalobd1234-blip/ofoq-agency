/**
 * Shared helpers for the AI tests.
 *
 * Every provider is reached through the `openai` SDK, which resolves
 * `globalThis.fetch` when the client is constructed. The service builds a fresh
 * client per attempt, so `vi.stubGlobal("fetch", mock)` before calling `chat()`
 * intercepts the call without a single byte leaving the test process.
 */
import { vi } from "vitest";

import { AI_PROVIDERS } from "../../src/lib/ai/providers";

/** A successful OpenAI-compatible chat completion. */
export function completionResponse(
  text: string,
  options: { model?: string; promptTokens?: number; completionTokens?: number } = {},
): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: options.model ?? "test-model",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: text },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: options.promptTokens ?? 11,
        completion_tokens: options.completionTokens ?? 27,
        total_tokens: (options.promptTokens ?? 11) + (options.completionTokens ?? 27),
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

/** An OpenAI-compatible error payload (429, 500, …). */
export function errorResponse(status: number, message = "provider failure"): Response {
  return new Response(
    JSON.stringify({ error: { message, type: "invalid_request_error", code: null, param: null } }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

/** Clears every provider key so a test starts from "nothing configured". */
export function clearProviderKeys(): void {
  for (const provider of AI_PROVIDERS) vi.stubEnv(provider.apiKeyEnv, "");
}

export function callUrl(fetchMock: ReturnType<typeof vi.fn>, index: number): string {
  return String(fetchMock.mock.calls[index]?.[0] ?? "");
}

/**
 * Request headers of the nth fetch call, with LOWERCASE keys (HTTP headers are
 * case-insensitive and both SDKs use different casing).
 */
export function callHeaders(fetchMock: ReturnType<typeof vi.fn>, index: number): Record<string, string> {
  const init = fetchMock.mock.calls[index]?.[1] as { headers?: Record<string, string> | Headers } | undefined;
  const headers = init?.headers;
  if (!headers) return {};
  const raw =
    typeof Headers !== "undefined" && headers instanceof Headers
      ? Object.fromEntries(headers.entries())
      : Array.isArray(headers)
        ? Object.fromEntries(headers as [string, string][])
        : (headers as Record<string, string>);
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key.toLowerCase(), value]));
}

export function callBody(fetchMock: ReturnType<typeof vi.fn>, index: number): Record<string, unknown> {
  const init = fetchMock.mock.calls[index]?.[1] as { body?: string } | undefined;
  if (!init?.body) return {};
  try {
    return JSON.parse(init.body) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * A fetch that never answers until the caller's AbortSignal fires — used to
 * exercise the 30-second timeout path without actually waiting 30 seconds.
 */
export function hangingFetch(): ReturnType<typeof vi.fn> {
  return vi.fn().mockImplementation(
    (_url: string, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const abort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
        if (signal?.aborted) return abort();
        signal?.addEventListener("abort", abort, { once: true });
      }),
  );
}
