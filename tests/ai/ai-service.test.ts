import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AiUnavailableError,
  chat,
  isArabicText,
  messagesContainArabic,
  providerModels,
  providerOrder,
  requestPreference,
} from "../../src/lib/ai/ai-service";
import { getAiProvider } from "../../src/lib/ai/providers";
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
      .mockResolvedValue(completionResponse("Groq answered.", { model: "openai/gpt-oss-120b" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await chat(ENGLISH);

    expect(result.provider).toBe("groq");
    expect(result.model).toBe("openai/gpt-oss-120b");
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
    expect(callBody(fetchMock, 0).model).toBe("openai/gpt-oss-120b");
    expect(result.attempts.map((attempt) => attempt.status)).toEqual(["OK"]);
  });

  it("falls back to the next provider when the first one is rate limited (429)", async () => {
    clearProviderKeys();
    vi.stubEnv("GROQ_API_KEY", "unit-test-key");
    vi.stubEnv("GEMINI_API_KEY", "unit-test-key");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(429, "rate limit exceeded"))
      .mockResolvedValueOnce(errorResponse(429, "rate limit exceeded"))
      .mockResolvedValueOnce(errorResponse(429, "rate limit exceeded"))
      .mockResolvedValueOnce(completionResponse("Gemini answered.", { model: "gemini-2.5-flash" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await chat(ENGLISH);

    expect(result.provider).toBe("gemini");
    expect(result.text).toBe("Gemini answered.");
    // Groq's whole model list is rate limited before the chain moves on.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(callUrl(fetchMock, 0)).toContain("api.groq.com");
    expect(callUrl(fetchMock, 1)).toContain("api.groq.com");
    expect(callUrl(fetchMock, 2)).toContain("api.groq.com");
    expect(callUrl(fetchMock, 3)).toContain("generativelanguage.googleapis.com/v1beta/openai");
    expect(result.attempts.map((attempt) => [attempt.provider, attempt.status])).toEqual([
      ["groq", "RATE_LIMIT"],
      ["groq", "RATE_LIMIT"],
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
      .mockResolvedValueOnce(errorResponse(503, "upstream unavailable"))
      .mockResolvedValueOnce(errorResponse(503, "upstream unavailable"))
      .mockResolvedValueOnce(
        completionResponse("NVIDIA answered.", { model: "google/gemma-4-31b-it" }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await chat(ENGLISH);

    expect(result.provider).toBe("nvidia");
    expect(fetchMock).toHaveBeenCalledTimes(4);
    // Groq (three models) then NVIDIA (its default model).
    expect(callUrl(fetchMock, 2)).toContain("api.groq.com");
    expect(callUrl(fetchMock, 3)).toContain("integrate.api.nvidia.com/v1");
    expect(callBody(fetchMock, 3).model).toBe("google/gemma-4-31b-it");
    expect(result.attempts.map((attempt) => [attempt.provider, attempt.status])).toEqual([
      ["groq", "PROVIDER_ERROR"],
      ["groq", "PROVIDER_ERROR"],
      ["groq", "PROVIDER_ERROR"],
      // Gemini has no key in this test: recorded, but never called.
      ["gemini", "MISSING_KEY"],
      ["nvidia", "OK"],
    ]);
  });

  it("falls back to the provider's next model when the default one is retired (404)", async () => {
    clearProviderKeys();
    vi.stubEnv("GROQ_API_KEY", "unit-test-key");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        errorResponse(404, "The model `openai/gpt-oss-120b` does not exist or you do not have access to it."),
      )
      .mockResolvedValueOnce(completionResponse("Groq fallback answered.", { model: "openai/gpt-oss-20b" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await chat(ENGLISH);

    // Still Groq: one retired ID must not cost the whole provider.
    expect(result.provider).toBe("groq");
    expect(result.model).toBe("openai/gpt-oss-20b");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(callUrl(fetchMock, 0)).toContain("api.groq.com");
    expect(callUrl(fetchMock, 1)).toContain("api.groq.com");
    expect(callBody(fetchMock, 0).model).toBe("openai/gpt-oss-120b");
    expect(callBody(fetchMock, 1).model).toBe("openai/gpt-oss-20b");
    expect(result.attempts.map((attempt) => [attempt.provider, attempt.model, attempt.status])).toEqual([
      ["groq", "openai/gpt-oss-120b", "PROVIDER_ERROR"],
      ["groq", "openai/gpt-oss-20b", "OK"],
    ]);
  });

  it("does not waste attempts on the same provider when its key is rejected (401)", async () => {
    clearProviderKeys();
    vi.stubEnv("GROQ_API_KEY", "unit-test-key");
    vi.stubEnv("NVIDIA_API_KEY", "unit-test-key");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(401, "invalid api key"))
      .mockResolvedValueOnce(
        completionResponse("NVIDIA answered.", { model: "nvidia/nemotron-3.5-lightning-30b-a3b" }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await chat(ENGLISH);

    // Groq's other models share the same rejected key: go straight to NVIDIA.
    expect(result.provider).toBe("nvidia");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(callUrl(fetchMock, 1)).toContain("integrate.api.nvidia.com/v1");
    expect(result.attempts.map((attempt) => [attempt.provider, attempt.status])).toEqual([
      ["groq", "PROVIDER_ERROR"],
      ["gemini", "MISSING_KEY"],
      ["nvidia", "OK"],
    ]);
  });

  it("orders the models of a provider, with an explicit caller model first", () => {
    const groq = getAiProvider("groq");
    expect(groq).not.toBeNull();
    const all = ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.8-27b"];
    expect(providerModels(groq!)).toEqual(all);
    expect(providerModels(groq!, { model: "openai/gpt-oss-20b" })).toEqual([
      "openai/gpt-oss-20b",
      "openai/gpt-oss-120b",
      "qwen/qwen3.8-27b",
    ]);
    // A caller model the provider does not declare is tried first, then the list.
    expect(providerModels(groq!, { model: "openai/gpt-oss-120b-preview" })).toEqual([
      "openai/gpt-oss-120b-preview",
      ...all,
    ]);
    // Unsafe or blank overrides are ignored.
    expect(providerModels(groq!, { model: "  " })).toEqual(all);
    expect(providerModels(groq!, { model: "bad model!" })).toEqual(all);
  });

  it("picks the provider model that suits the request kind, keeping the fallbacks", () => {
    const groq = getAiProvider("groq")!;
    const nvidia = getAiProvider("nvidia")!;
    const openrouter = getAiProvider("openrouter")!;

    // Arabic goes to the multilingual model, and the rest stay behind it.
    expect(providerModels(groq, { prefer: "arabic" })).toEqual([
      "qwen/qwen3.8-27b",
      "openai/gpt-oss-120b",
      "openai/gpt-oss-20b",
    ]);
    expect(providerModels(nvidia, { prefer: "arabic" })[0]).toBe("google/gemma-4-31b-it");
    expect(providerModels(openrouter, { prefer: "arabic" })[0]).toBe("google/gemma-4-31b-it:free");

    // Speed and accuracy use the small / large member of each free list.
    expect(providerModels(groq, { prefer: "fast" })[0]).toBe("openai/gpt-oss-20b");
    expect(providerModels(groq, { prefer: "accurate" })[0]).toBe("openai/gpt-oss-120b");
    expect(providerModels(nvidia, { prefer: "fast" })[0]).toBe("nvidia/nemotron-3.5-lightning-30b-a3b");
    expect(providerModels(openrouter, { prefer: "fast" })[0]).toBe("google/gemma-4-26b-a4b-it:free");

    // A fallback is never dropped: every declared model is still in the chain.
    for (const list of [
      providerModels(groq, { prefer: "arabic" }),
      providerModels(nvidia, { prefer: "fast" }),
      providerModels(openrouter, { prefer: "accurate" }),
    ]) {
      expect(new Set(list).size).toBe(list.length);
    }
    expect(providerModels(groq, { prefer: "arabic" })).toHaveLength(groq.models.length);

    // An explicit model outranks the hint, and providers without roles ignore it.
    expect(providerModels(groq, { model: "openai/gpt-oss-20b", prefer: "arabic" })[0]).toBe(
      "openai/gpt-oss-20b",
    );
    expect(providerModels(groq, { model: "openai/gpt-oss-20b", prefer: "arabic" })).toEqual([
      "openai/gpt-oss-20b",
      "qwen/qwen3.8-27b",
      "openai/gpt-oss-120b",
    ]);
    expect(providerModels(getAiProvider("gemini")!, { prefer: "arabic" })[0]).toBe("gemini-2.5-flash");
  });

  it("derives the request kind from the text, so Arabic is routed without asking", async () => {
    // Pure helper first: an explicit hint wins, Arabic script implies "arabic".
    expect(requestPreference(ENGLISH)).toBeUndefined();
    expect(requestPreference(ARABIC)).toBe("arabic");
    expect(requestPreference(ARABIC, { prefer: "fast" })).toBe("fast");

    clearProviderKeys();
    vi.stubEnv("GROQ_API_KEY", "unit-test-key");
    // A fresh Response per call: a Response body can only be read once.
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(completionResponse("أهلًا بك.", { model: "qwen/qwen3.8-27b" })));
    vi.stubGlobal("fetch", fetchMock);

    // Arabic message → Groq's Arabic-role model is the one on the wire.
    await chat(ARABIC);
    expect(callBody(fetchMock, 0).model).toBe("qwen/qwen3.8-27b");

    // A caller hint outranks the detection.
    fetchMock.mockClear();
    await chat(ARABIC, { prefer: "fast" });
    expect(callBody(fetchMock, 0).model).toBe("openai/gpt-oss-20b");

    // English with no hint keeps the provider default.
    fetchMock.mockClear();
    await chat(ENGLISH);
    expect(callBody(fetchMock, 0).model).toBe("openai/gpt-oss-120b");
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
    // Groq (3 models) + Gemini (3 models): one attempt per declared model.
    expect(failing).toHaveBeenCalledTimes(6);
  });
});
