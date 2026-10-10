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
    expect(byId.groq?.models).toEqual(["llama-3.3-70b-versatile", "llama-3.1-8b-instant"]);
    expect(byId.groq?.dailyLimit).toBe(14_400);
    expect(byId.groq?.limitUnit).toBe("day");

    expect(byId.gemini?.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta/openai");
    expect(byId.gemini?.models).toEqual(["gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.5-pro"]);
    expect(byId.gemini?.dailyLimit).toBe(1_500);

    expect(byId.nvidia?.baseUrl).toBe("https://integrate.api.nvidia.com/v1");
    expect(byId.nvidia?.models).toEqual([
      "meta/llama-3.3-70b-instruct",
      "nvidia/llama-3.1-nemotron-70b-instruct",
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
      "meta-llama/llama-3.3-70b-instruct:free",
      "qwen/qwen-2.5-72b-instruct:free",
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
    expect(statuses.find((status) => status.id === "groq")?.activeModel).toBe("llama-3.3-70b-versatile");
    expect(statuses.find((status) => status.id === "cohere")?.arabicFirst).toBe(true);

    // The badge name for the local rules engine is part of the same vocabulary.
    expect(providerLabel("groq", "ar")).toBe("Groq");
    expect(providerLabel("rules", "en")).toBe("local rules");
    expect(providerLabel("unknown", "ar")).toBe("unknown");
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
