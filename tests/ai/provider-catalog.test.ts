import { afterEach, describe, expect, it, vi } from "vitest";

import { getAiProvider } from "../../src/lib/ai/providers";
import {
  extractModelIds,
  fetchProviderModels,
  liveModelReport,
  missingModels,
  normaliseModelId,
} from "../../src/lib/ai/provider-catalog";
import { clearProviderKeys } from "./completion-mock";

afterEach(() => {
  vi.unstubAllEnvs();
});

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("live model catalogue", () => {
  it("reads the shapes the five providers return", () => {
    // Groq / NVIDIA / OpenRouter / Gemini (OpenAI compatibility).
    expect(extractModelIds({ data: [{ id: "openai/gpt-oss-120b" }, { id: "openai/gpt-oss-20b" }] })).toEqual([
      "openai/gpt-oss-120b",
      "openai/gpt-oss-20b",
    ]);
    // Gemini prefixes ids with "models/".
    expect(extractModelIds({ data: [{ id: "models/gemini-2.5-flash" }] })).toEqual(["gemini-2.5-flash"]);
    // Cohere v2 style.
    expect(extractModelIds({ models: [{ name: "command-r-plus-08-2024" }] })).toEqual([
      "command-r-plus-08-2024",
    ]);
    // Bare arrays and junk.
    expect(extractModelIds(["a", { id: "b" }, 42, null])).toEqual(["a", "b"]);
    expect(extractModelIds(null)).toEqual([]);
    expect(extractModelIds({})).toEqual([]);
  });

  it("flags declared models the provider no longer serves", () => {
    expect(normaliseModelId(" models/gemini-2.0-flash ")).toBe("gemini-2.0-flash");

    const live = ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.8-27b"];
    expect(missingModels(["openai/gpt-oss-120b", "openai/gpt-oss-20b"], live)).toEqual([]);
    expect(missingModels(["openai/gpt-oss-120b", "llama-3.3-70b-versatile"], live)).toEqual([
      "llama-3.3-70b-versatile",
    ]);
    // Gemini's "models/" prefix must not look like a missing model.
    expect(missingModels(["gemini-2.5-flash"], ["models/gemini-2.5-flash"])).toEqual([]);
  });

  it("calls {baseUrl}/models with the provider key and never throws", async () => {
    const groq = getAiProvider("groq")!;
    vi.stubEnv("GROQ_API_KEY", "unit-test-key");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ data: [{ id: "openai/gpt-oss-120b" }] }));
    vi.stubGlobal("fetch", fetchMock);

    const ok = await fetchProviderModels(groq, { fetchImpl: fetchMock as unknown as typeof fetch });
    expect(ok.ids).toEqual(["openai/gpt-oss-120b"]);
    expect(ok.error).toBeUndefined();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.groq.com/openai/v1/models");
    const headers = (fetchMock.mock.calls[0]?.[1] as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBe("Bearer unit-test-key");

    // A rejected key is reported, not thrown.
    const unauthorized = vi.fn().mockResolvedValue(jsonResponse({ error: "nope" }, 401));
    expect(await fetchProviderModels(groq, { fetchImpl: unauthorized as unknown as typeof fetch })).toMatchObject(
      { ids: null, error: "HTTP 401 from https://api.groq.com/openai/v1/models." },
    );

    // A network failure is reported too.
    const offline = vi.fn().mockRejectedValue(new Error("socket hang up"));
    expect(await fetchProviderModels(groq, { fetchImpl: offline as unknown as typeof fetch })).toMatchObject({
      ids: null,
      error: "socket hang up",
    });

    // A provider without a key is a configuration state, not a request.
    clearProviderKeys();
    const noKey = vi.fn();
    await expect(
      fetchProviderModels(groq, { fetchImpl: noKey as unknown as typeof fetch }),
    ).resolves.toMatchObject({ ids: null });
    expect(noKey).not.toHaveBeenCalled();
  });

  it("reports every provider, staying silent about models when a key is missing", async () => {
    clearProviderKeys();
    vi.stubEnv("GROQ_API_KEY", "unit-test-key");
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ data: [{ id: "openai/gpt-oss-120b" }, { id: "openai/gpt-oss-20b" }] }),
    );

    const report = await liveModelReport({ fetchImpl: fetchMock as unknown as typeof fetch });

    expect(report.map((row) => row.id)).toEqual(["groq", "gemini", "nvidia", "cohere", "openrouter"]);
    const groq = report.find((row) => row.id === "groq")!;
    expect(groq.configured).toBe(true);
    // qwen/qwen3.8-27b is declared but not served in this mock → flagged.
    expect(groq.missingDeclared).toEqual(["qwen/qwen3.8-27b"]);
    expect(fetchMock).toHaveBeenCalledOnce();

    for (const row of report.filter((entry) => entry.id !== "groq")) {
      expect(row.configured).toBe(false);
      expect(row.liveModels).toBeNull();
      expect(row.error).toContain("API_KEY");
    }

    // One provider can be checked on its own.
    const single = await liveModelReport({
      providerId: "groq",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(single).toHaveLength(1);
  });
});
