import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AI_PROVIDERS,
  configuredProviders,
  firstConfiguredProvider,
  getAiProvider,
  isConfigured,
  providerLabel,
  providerStatuses,
  providersByPriority,
} from "../../src/lib/ai/providers";
import { clearProviderKeys } from "./completion-mock";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("AI provider registry", () => {
  it("declares the five providers in priority order with their environment variable names", () => {
    expect(AI_PROVIDERS).toHaveLength(5);
    expect(providersByPriority().map((provider) => provider.id)).toEqual([
      "groq",
      "gemini",
      "nvidia",
      "cohere",
      "openrouter",
    ]);
    expect(AI_PROVIDERS.map((provider) => provider.apiKeyEnv)).toEqual([
      "GROQ_API_KEY",
      "GEMINI_API_KEY",
      "NVIDIA_API_KEY",
      "COHERE_API_KEY",
      "OPENROUTER_API_KEY",
    ]);
    // Priority is real ordering data, not just a comment.
    expect(providersByPriority().map((provider) => provider.priority)).toEqual([1, 2, 3, 4, 5]);
    // Cohere is the Arabic specialist and the only provider flagged as such.
    expect(AI_PROVIDERS.filter((provider) => provider.arabicFirst).map((p) => p.id)).toEqual(["cohere"]);
  });

  it("uses the documented OpenAI-compatible endpoints, models and limits", () => {
    const byId = Object.fromEntries(AI_PROVIDERS.map((provider) => [provider.id, provider]));

    expect(byId.groq?.baseUrl).toBe("https://api.groq.com/openai/v1");
    expect(byId.groq?.models).toEqual([
      "openai/gpt-oss-120b",
      "openai/gpt-oss-20b",
      "qwen/qwen3.8-27b",
    ]);
    expect(byId.groq?.dailyLimit).toBe(1_000);
    expect(byId.groq?.limitUnit).toBe("day");

    expect(byId.gemini?.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta/openai");
    expect(byId.gemini?.models).toEqual(["gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.5-pro"]);
    expect(byId.gemini?.dailyLimit).toBe(1_500);

    expect(byId.nvidia?.baseUrl).toBe("https://integrate.api.nvidia.com/v1");
    expect(byId.nvidia?.models).toEqual([
      "google/gemma-4-31b-it",
      "nvidia/nemotron-3.5-lightning-30b-a3b",
      "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
    ]);
    expect(byId.nvidia?.dailyLimit).toBe(40);
    expect(byId.nvidia?.limitUnit).toBe("minute");

    expect(byId.cohere?.baseUrl).toBe("https://api.cohere.ai/compatibility/v1");
    expect(byId.cohere?.models).toEqual([
      "command-r7b-arabic-02-2025",
      "command-r-plus-08-2024",
    ]);
    expect(byId.cohere?.dailyLimit).toBe(1_000);
    expect(byId.cohere?.limitUnit).toBe("month");

    expect(byId.openrouter?.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(byId.openrouter?.models).toEqual([
      "google/gemma-4-31b-it:free",
      "google/gemma-4-26b-a4b-it:free",
      "nvidia/nemotron-3-super-120b-a12b:free",
    ]);
    expect(byId.openrouter?.dailyLimit).toBe(50);
  });

  it("reads keys from process.env only, treats placeholders as missing, and exposes safe status metadata", () => {
    clearProviderKeys();
    expect(isConfigured("groq")).toBe(false);
    expect(configuredProviders()).toEqual([]);
    expect(firstConfiguredProvider()).toBeNull();

    vi.stubEnv("GROQ_API_KEY", "unit-test-key");
    expect(isConfigured("groq")).toBe(true);
    expect(isConfigured(getAiProvider("groq"))).toBe(true);
    expect(firstConfiguredProvider()?.id).toBe("groq");

    vi.stubEnv("GROQ_API_KEY", "   ");
    expect(isConfigured("groq")).toBe(false);
    vi.stubEnv("GROQ_API_KEY", "undefined");
    expect(isConfigured("groq")).toBe(false);

    // Unknown ids are never configured, and never throw.
    expect(isConfigured("unknown-provider")).toBe(false);
    expect(isConfigured(null)).toBe(false);
    expect(getAiProvider("nope")).toBeNull();

    // Status metadata for the owner screen: variable names only, never values.
    clearProviderKeys();
    vi.stubEnv("COHERE_API_KEY", "unit-test-key");

    const statuses = providerStatuses();
    expect(statuses).toHaveLength(5);
    expect(statuses[0]?.id).toBe("groq");
    expect(statuses.find((status) => status.id === "cohere")?.configured).toBe(true);
    expect(statuses.find((status) => status.id === "groq")?.configured).toBe(false);
    expect(statuses.find((status) => status.id === "groq")?.activeModel).toBe("openai/gpt-oss-120b");
    expect(statuses.find((status) => status.id === "cohere")?.arabicFirst).toBe(true);

    // The badge name for the local rules engine is part of the same vocabulary.
    expect(providerLabel("groq", "ar")).toBe("Groq");
    expect(providerLabel("rules", "en")).toBe("local rules");
    expect(providerLabel("unknown", "ar")).toBe("unknown");
  });

  it("lists only free models, with same-provider fallbacks and role hints that exist", () => {
    for (const provider of AI_PROVIDERS) {
      const models = [...provider.models];
      // models[0] is the default, the remaining entries are the fallbacks, and
      // the list itself is what `providerStatuses().activeModel` reports.
      expect(models.length).toBeGreaterThanOrEqual(2);
      expect(new Set(models).size).toBe(models.length);
      expect(models.every((model) => model.trim().length > 0)).toBe(true);
      // Every role hint must point at a model this provider actually declares,
      // otherwise the "prefer" step would silently do nothing.
      for (const [kind, model] of Object.entries(provider.modelRoles ?? {})) {
        expect(["arabic", "fast", "accurate"]).toContain(kind);
        expect(models).toContain(model);
      }
    }

    // The three providers that broke the connection test declare three free
    // models each: one to call, two to fall back to.
    const byId = Object.fromEntries(AI_PROVIDERS.map((provider) => [provider.id, provider]));
    for (const id of ["groq", "nvidia", "openrouter"] as const) {
      expect(byId[id]?.models).toHaveLength(3);
    }
  });

  it("never pins a retired or paid model ID again", () => {
    const everyModel = AI_PROVIDERS.flatMap((provider) => [...provider.models]).join(" ");

    // Groq: retired chat models (mixtral/gemma2 in 2025, both Llama chat models
    // on 2026-08-16) — the Llama pair is Enterprise-only now.
    expect(everyModel).not.toMatch(/llama-3\.3-70b-versatile/);
    expect(everyModel).not.toMatch(/llama-3\.1-8b-instant/);
    expect(everyModel).not.toMatch(/mixtral-8x7b-32768/);
    expect(everyModel).not.toMatch(/gemma2-9b-it/);
    // NVIDIA: end-of-life, missing or paid-only endpoints.
    expect(everyModel).not.toMatch(/meta\/llama-3\.3-70b-instruct/);
    expect(everyModel).not.toMatch(/meta\/llama-3\.1-8b-instruct/);
    expect(everyModel).not.toMatch(/mistralai\/mistral-7b-instruct-v0\.3/);
    expect(everyModel).not.toMatch(/nvidia\/llama-3\.1-nemotron-70b-instruct/);
    // OpenRouter: :free slugs with no serving provider left, and paid slugs.
    expect(everyModel).not.toMatch(/meta-llama\/llama-3\.3-70b-instruct:free/);
    expect(everyModel).not.toMatch(/meta-llama\/llama-3\.2-3b-instruct:free/);
    expect(everyModel).not.toMatch(/gemma-2-9b-it:free/);
    expect(everyModel).not.toMatch(/qwen\/qwen-2\.5-7b-instruct:free/);
    expect(everyModel).not.toMatch(/qwen-2\.5-72b-instruct/);
    // A paid endpoint would be exactly the bug that broke the connection test:
    // these IDs exist, but their build page prices them per 1M tokens, so a free
    // key cannot call them. (`:free` slugs on OpenRouter are the free ones.)
    const everyId = AI_PROVIDERS.flatMap((provider) => [...provider.models]);
    for (const paid of [
      "nvidia/nemotron-3-super-120b-a12b",
      "moonshotai/kimi-k3",
      "meta-llama/llama-3.3-70b-instruct",
    ]) {
      expect(everyId).not.toContain(paid);
    }
  });

  it("never hardcodes a key in the AI or email source files", () => {
    const files = [
      "src/lib/ai/providers.ts",
      "src/lib/ai/ai-service.ts",
      "src/lib/ai/usage.ts",
      "src/lib/email/email-service.ts",
    ].map((file) => fs.readFileSync(path.join(process.cwd(), file), "utf8"));

    for (const source of files) {
      expect(source).not.toMatch(/sk-[A-Za-z0-9]{10,}/);
      expect(source).not.toMatch(/gsk_[A-Za-z0-9]{10,}/);
      expect(source).not.toMatch(/AIza[0-9A-Za-z_-]{10,}/);
      expect(source).not.toMatch(/re_[A-Za-z0-9]{12,}/);
      expect(source).not.toMatch(/nvapi-[A-Za-z0-9_-]{10,}/);
      // Keys are only ever read through process.env[…].
      expect(source).not.toMatch(/apiKey\s*:\s*["']/);
    }
  });
});
