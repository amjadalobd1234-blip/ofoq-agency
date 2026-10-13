import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { extractBudgetIntent, parseBudgetAnswer, resolveBudgetIntent } from "../src/lib/agents/budget-intent";

import { callBody, callUrl, clearProviderKeys, completionResponse, errorResponse } from "./ai/completion-mock";

/**
 * Layer 2 of the budget reader: when the patterns cannot read a budget, the
 * message goes to the AI provider chain (Groq first) which answers with the
 * amount or range only. The answer is validated and normalised here, so the AI
 * path stores exactly the same `200-500` shape as the pattern path — and a
 * model that invents a number can never price a request.
 */

function stubGroq(answer: string) {
  clearProviderKeys();
  vi.stubEnv("GROQ_API_KEY", "unit-test-key");
  const fetchMock = vi.fn().mockResolvedValue(completionResponse(answer, { model: "openai/gpt-oss-120b" }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  clearProviderKeys();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("parseBudgetAnswer — validating what the model says", () => {
  it("accepts a range in either order and normalises it to 200-500", () => {
    expect(parseBudgetAnswer('{"min": 200, "max": 500, "currency": "USD"}')).toMatchObject({ min: 200, max: 500, text: "200-500", kind: "range" });
    expect(parseBudgetAnswer('{"min": 500, "max": 200, "currency": null}')).toMatchObject({ min: 200, max: 500, text: "200-500" });
    expect(parseBudgetAnswer('```json\n{"min": "200", "max": "500", "currency": "usd"}\n```')).toMatchObject({ text: "200-500" });
  });

  it("accepts a single amount", () => {
    expect(parseBudgetAnswer('{"min": 500, "max": 500, "currency": "USD"}')).toMatchObject({ min: 500, max: 500, text: "500", kind: "single" });
    expect(parseBudgetAnswer('{"min": null, "max": 350, "currency": null}')).toMatchObject({ text: "350" });
    expect(parseBudgetAnswer('{"amount": 1000}')).toMatchObject({ text: "1000" });
  });

  it("refuses no-budget answers, other currencies, nonsense and garbage", () => {
    expect(parseBudgetAnswer('{"min": null, "max": null, "currency": null}')).toBeNull();
    expect(parseBudgetAnswer('{"min": 500000, "max": 750000, "currency": "IQD"}')).toBeNull();
    expect(parseBudgetAnswer('{"min": -5, "max": 0}')).toBeNull();
    expect(parseBudgetAnswer('{"min": 1e12, "max": 1e12}')).toBeNull();
    expect(parseBudgetAnswer("sure, about five hundred")).toBeNull();
    expect(parseBudgetAnswer("")).toBeNull();
    expect(parseBudgetAnswer("{not json")).toBeNull();
  });
});

describe("resolveBudgetIntent — hybrid", () => {
  it("answers locally for pattern messages without calling any provider", async () => {
    const fetchMock = stubGroq('{"min": 999, "max": 999, "currency": "USD"}');
    const resolution = await resolveBudgetIntent("طيب من 200 إلى 500");
    expect(resolution).toEqual({ budget: expect.objectContaining({ text: "200-500", min: 200, max: 500 }), source: "local" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks Groq for number words and stores the normalised range", async () => {
    const fetchMock = stubGroq('{"min": 500, "max": 200, "currency": "USD"}');
    const resolution = await resolveBudgetIntent("خلي ميزانيتي بين المئتين والخمسمية");

    expect(resolution.source).toBe("ai");
    expect(resolution.provider).toBe("groq");
    expect(resolution.budget).toMatchObject({ min: 200, max: 500, text: "200-500" });
    expect(callUrl(fetchMock, 0)).toContain("api.groq.com");
    const body = callBody(fetchMock, 0) as { messages: Array<{ role: string; content: string }>; temperature: number };
    expect(body.temperature).toBe(0);
    expect(body.messages[0]?.role).toBe("system");
    expect(body.messages.at(-1)).toEqual({ role: "user", content: "خلي ميزانيتي بين المئتين والخمسمية" });
  });

  it("reads a single spoken amount through the AI", async () => {
    stubGroq('{"min": 500, "max": 500, "currency": "USD"}');
    const resolution = await resolveBudgetIntent("خمسمية دولار تقريباً");
    expect(resolution.source).toBe("ai");
    expect(resolution.budget).toMatchObject({ text: "500", min: 500, max: 500 });
  });

  it("does not ask the model about a phone number", async () => {
    const fetchMock = stubGroq('{"min": 7707048629, "max": 7707048629, "currency": null}');
    expect(await resolveBudgetIntent("رقمي 07707048629", { bareNumbers: true })).toEqual({ budget: null, source: "none" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns no budget — never a guess — when the model finds none", async () => {
    stubGroq('{"min": null, "max": null, "currency": null}');
    expect(await resolveBudgetIntent("بغداد فقط")).toMatchObject({ budget: null, source: "none", provider: "groq" });
  });

  it("returns no budget when the provider fails or is not configured", async () => {
    clearProviderKeys();
    vi.stubEnv("GROQ_API_KEY", "unit-test-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(errorResponse(500, "boom")));
    expect((await resolveBudgetIntent("نص ألف تقريباً")).budget).toBeNull();

    clearProviderKeys();
    expect(await extractBudgetIntent("نص ألف تقريباً")).toEqual({ budget: null });
    expect(await resolveBudgetIntent("")).toMatchObject({ budget: null, source: "none" });
  });
});
