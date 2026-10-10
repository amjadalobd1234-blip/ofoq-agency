import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AiUnavailableError,
  chat,
  isArabicText,
  messagesContainArabic,
  providerOrder,
} from "../../src/lib/ai/ai-service";
import type { AiUsageEntry } from "../../src/lib/ai/usage";
import {
  callBody,
  callHeaders,
  callUrl,
  clearProviderKeys,
  completionResponse,
  errorResponse,
  hangingFetch,
} from "./completion-mock";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const ENGLISH = [{ role: "user" as const, content: "I need social media management for my shop." }];
const ARABIC = [{ role: "user" as const, content: "أحتاج إدارة حسابات التواصل لمتجري." }];

describe("AI service fallback chain", () => {
  it("calls Groq first and returns text, provider, model and usage", async () => {
    clearProviderKeys();
    vi.stubEnv("GROQ_API_KEY", "unit-test-key");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(completionResponse("Groq answered.", { model: "llama-3.3-70b-versatile" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await chat(ENGLISH);

    expect(result.provider).toBe("groq");
    expect(result.model).toBe("llama-3.3-70b-versatile");
    expect(result.text).toBe("Groq answered.");
    expect(result.usage).toEqual({
      inputTokens: 11,
      outputTokens: 27,
      totalTokens: 38,
      durationMs: expect.any(Number),
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(callUrl(fetchMock, 0)).toContain("https://api.groq.com/openai/v1/chat/completions");
    expect(callHeaders(fetchMock, 0).authorization).toBe("Bearer unit-test-key");
    expect(callBody(fetchMock, 0).model).toBe("llama-3.3-70b-versatile");
    expect(result.attempts.map((attempt) => attempt.status)).toEqual(["OK"]);
  });

  it("falls back to the next provider when the first one is rate limited (429)", async () => {
    clearProviderKeys();
    vi.stubEnv("GROQ_API_KEY", "unit-test-key");
    vi.stubEnv("GEMINI_API_KEY", "unit-test-key");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(429, "rate limit exceeded"))
      .mockResolvedValueOnce(completionResponse("Gemini answered.", { model: "gemini-2.5-flash" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await chat(ENGLISH);

    expect(result.provider).toBe("gemini");
    expect(result.text).toBe("Gemini answered.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(callUrl(fetchMock, 0)).toContain("api.groq.com");
    expect(callUrl(fetchMock, 1)).toContain("generativelanguage.googleapis.com/v1beta/openai");
    expect(result.attempts.map((attempt) => [attempt.provider, attempt.status])).toEqual([
      ["groq", "RATE_LIMIT"],
      ["gemini", "OK"],
    ]);
  });

  it("falls back when a provider returns a server error (5xx)", async () => {
    clearProviderKeys();
    vi.stubEnv("GROQ_API_KEY", "unit-test-key");
    vi.stubEnv("NVIDIA_API_KEY", "unit-test-key");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(503, "upstream unavailable"))
      .mockResolvedValueOnce(
        completionResponse("NVIDIA answered.", { model: "meta/llama-3.3-70b-instruct" }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await chat(ENGLISH);

    expect(result.provider).toBe("nvidia");
    expect(callUrl(fetchMock, 1)).toContain("integrate.api.nvidia.com/v1");
    expect(result.attempts[0]).toMatchObject({ provider: "groq", status: "PROVIDER_ERROR" });
  });

  it("skips providers whose key is missing without spending a request", async () => {
    clearProviderKeys();
    // Only Cohere is configured: Groq, Gemini and NVIDIA must be skipped.
    vi.stubEnv("COHERE_API_KEY", "unit-test-key");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(completionResponse("Cohere answered.", { model: "command-r-plus-08-2024" }));
    vi.stubGlobal("fetch", fetchMock);

    const usage: AiUsageEntry[] = [];
    const result = await chat(ENGLISH, { onUsage: (entry) => void usage.push(entry) });

    expect(result.provider).toBe("cohere");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(callUrl(fetchMock, 0)).toContain("api.cohere.ai/compatibility/v1");
    expect(
      usage.filter((entry) => entry.status === "MISSING_KEY").map((entry) => entry.provider),
    ).toEqual(["groq", "gemini", "nvidia"]);
  });

  it("falls back when the first provider exceeds the timeout", async () => {
    clearProviderKeys();
    vi.stubEnv("GROQ_API_KEY", "unit-test-key");
    vi.stubEnv("OPENROUTER_API_KEY", "unit-test-key");
    // Groq hangs and only rejects when the service's own timeout aborts it;
    // OpenRouter then answers normally.
    const hanging = hangingFetch().getMockImplementation()!;
    const responder = vi
      .fn()
      .mockImplementationOnce(hanging)
      .mockResolvedValueOnce(completionResponse("OpenRouter answered."));
    vi.stubGlobal("fetch", responder);

    const result = await chat(ENGLISH, { timeoutMs: 1_000 });

    expect(result.provider).toBe("openrouter");
    expect(result.attempts[0]).toMatchObject({ provider: "groq", status: "TIMEOUT" });
    expect(responder).toHaveBeenCalledTimes(2);
  });

  it("prefers Cohere for Arabic messages, in detection and in the real request", async () => {
    expect(isArabicText("مرحبا بكم")).toBe(true);
    expect(isArabicText("hello")).toBe(false);
    expect(messagesContainArabic(ARABIC)).toBe(true);
    expect(messagesContainArabic(ENGLISH)).toBe(false);

    expect(providerOrder(ARABIC).map((provider) => provider.id)).toEqual([
      "cohere",
      "groq",
      "gemini",
      "nvidia",
      "openrouter",
    ]);
    expect(providerOrder(ENGLISH).map((provider) => provider.id)).toEqual([
      "groq",
      "gemini",
      "nvidia",
      "cohere",
      "openrouter",
    ]);
    expect(providerOrder(ENGLISH, { providerId: "nvidia" })[0]?.id).toBe("nvidia");

    clearProviderKeys();
    vi.stubEnv("COHERE_API_KEY", "unit-test-key");
    vi.stubEnv("GROQ_API_KEY", "unit-test-key");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(completionResponse("أهلًا بك.", { model: "command-r7b-arabic-02-2025" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await chat(ARABIC);

    expect(result.provider).toBe("cohere");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(callUrl(fetchMock, 0)).toContain("api.cohere.ai");
    expect(callBody(fetchMock, 0).model).toBe("command-r7b-arabic-02-2025");
  });

  it("reports a typed unavailable error when every provider fails or none is configured", async () => {
    clearProviderKeys();
    const usage: AiUsageEntry[] = [];

    // 1. Nothing configured at all → reason "no_provider", no network call.
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const noProvider = await chat(ENGLISH, { onUsage: (entry) => void usage.push(entry) }).catch(
      (error: unknown) => error,
    );
    expect(noProvider).toBeInstanceOf(AiUnavailableError);
    expect((noProvider as AiUnavailableError).reason).toBe("no_provider");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(usage.filter((entry) => entry.status === "MISSING_KEY")).toHaveLength(5);

    // 2. Keys exist but every provider errors → reason "all_failed".
    vi.stubEnv("GROQ_API_KEY", "unit-test-key");
    vi.stubEnv("GEMINI_API_KEY", "unit-test-key");
    const failing = vi.fn().mockResolvedValue(errorResponse(500, "boom"));
    vi.stubGlobal("fetch", failing);

    const allFailed = await chat(ENGLISH, { onUsage: () => undefined }).catch((error: unknown) => error);
    expect(allFailed).toBeInstanceOf(AiUnavailableError);
    expect((allFailed as AiUnavailableError).reason).toBe("all_failed");
    expect((allFailed as AiUnavailableError).attempts.at(-1)).toMatchObject({
      provider: "none",
      status: "UNAVAILABLE",
    });
    expect(failing).toHaveBeenCalledTimes(2);
  });
});
