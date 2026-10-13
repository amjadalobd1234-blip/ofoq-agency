/**
 * Issue 3 — the budget change is not understood.
 *
 * The client wrote «اريد الميزانية أكثر من 500» and the assistant answered
 * «لا يمكنني تأكيد الميزانية…». The route the chat calls is exercised here as
 * an HTTP endpoint, for every phrasing the client reported, because that is
 * where the body shape, the validation and the two layers meet:
 *
 *   POST /api/chat/budget-intent  { message, bareNumbers? }
 *
 *   1. the five phrasings the client must be able to use — «من 200 إلى 500»,
 *      «200-500», «أكثر من 500», «أقل من 200», «ميزانيتي 1000» — all resolve
 *      locally, without spending an AI call;
 *   2. an open budget is not a point value: «أكثر من 500» is a `>) 500` range
 *      priced on the published band (min 500 / max 1,500 → planning 1,000),
 *      which is what makes the answer «ميزانيتك الجديدة أكثر من $500…» land on
 *      the $1,000 anchor figures instead of a refusal;
 *   3. a phrasing the patterns cannot read is still answered — by the AI — and
 *      a phrase nobody can read comes back as `budget: null`, which the chat
 *      turns into the budget options again. `null` is the ONLY failing shape:
 *      the refusal the client saw is a bug, never a valid answer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { callBody, clearProviderKeys, completionResponse, errorResponse } from "./ai/completion-mock";

vi.mock("@/lib/supabase/route-auth", () => ({
  requireSupabaseUser: () =>
    Promise.resolve({
      client: { rpc: () => Promise.resolve({ data: null, error: null }) },
      user: { id: "user-1", email: "client@example.test" },
      requestId: "corr-1",
      finalize: (response: Response) => response,
    }),
}));

const { POST } = await import("../src/app/api/chat/budget-intent/route");

interface IntentResponse {
  data: {
    budget: { min: number; max: number; range: string; amount: number; kind: string } | null;
    source: string;
    provider: string | null;
  };
}

function post(body: unknown): Request {
  return new Request("http://localhost/api/chat/budget-intent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function ask(message: string, bareNumbers?: boolean): Promise<IntentResponse> {
  const response = await POST(post(bareNumbers === undefined ? { message } : { message, bareNumbers }));
  expect(response.status).toBe(200);
  return (await response.json()) as IntentResponse;
}

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

describe("POST /api/chat/budget-intent — every phrasing the client uses", () => {
  it.each([
    ["من 200 إلى 500", { min: 200, max: 500, range: "200-500", amount: 500, kind: "range" }],
    ["200-500", { min: 200, max: 500, range: "200-500", amount: 500, kind: "range" }],
    ["ميزانيتي 1000", { min: 1000, max: 1000, range: "1000", amount: 1000, kind: "single" }],
  ])("answers «%s» locally, without an AI call", async (message, expected) => {
    const fetchMock = vi.fn(() => Promise.reject(new Error("no provider call expected")));
    vi.stubGlobal("fetch", fetchMock);

    const payload = await ask(message);
    expect(payload.data).toEqual({ budget: expected, source: "local", provider: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads «أكثر من 500» as the open range it is, priced on its published band", async () => {
    const payload = await ask("اريد الميزانية أكثر من 500");

    // floor 500, band ceiling 1,500 (500_1500), planning amount 1,000 → the
    // $1,000 anchor: ~185,000-345,000 impressions. NOT 500, and never a refusal.
    expect(payload.data).toEqual({
      budget: { min: 500, max: 1500, range: ">500", amount: 1000, kind: "over" },
      source: "local",
      provider: null,
    });
  });

  it("reads «أقل من 200» as the open range below the first band", async () => {
    const payload = await ask("أقل من 200");

    expect(payload.data).toEqual({
      budget: { min: 0, max: 200, range: "<200", amount: 200, kind: "under" },
      source: "local",
      provider: null,
    });
  });

  it("keeps the bare-number reading for the budget question itself", async () => {
    expect((await ask("300", true)).data.budget).toMatchObject({ range: "300", amount: 300, kind: "single" });
    // The same text outside the question is not a budget (it is a phone number,
    // a count, a date…), so the chat must fall back to the options instead of
    // guessing 300$.
    expect((await ask("300")).data).toEqual({ budget: null, source: "none", provider: null });
  });

  it("still answers an unfamiliar wording through the AI, normalised to the same shape", async () => {
    const fetchMock = stubGroq('{"min": 800, "max": 800, "currency": "USD"}');

    const payload = await ask("خليها حوالي ثمانميّة دولار");
    expect(payload.data).toEqual({
      budget: { min: 800, max: 800, range: "800", amount: 800, kind: "single" },
      source: "ai",
      provider: "groq",
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("api.groq.com");
    expect(callBody(fetchMock, 0)).toMatchObject({ temperature: 0 });
  });

  it("returns null — never a refusal and never a guess — when the AI cannot read it either", async () => {
    stubGroq("sorry, I cannot confirm the budget");

    const unreadable = await ask("الميزانية على كيفكم");
    expect(unreadable.data).toEqual({ budget: null, source: "none", provider: "groq" });

    // Provider down is the same shape: the chat shows the budget options again.
    clearProviderKeys();
    vi.stubEnv("GROQ_API_KEY", "unit-test-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(errorResponse(500, "boom")));
    expect((await ask("خليها حوالي ثمانميّة دولار")).data).toEqual({ budget: null, source: "none", provider: null });
  });

  it("refuses an empty or non-text body with 400", async () => {
    expect((await POST(post({ message: "   " }))).status).toBe(400);
    expect((await POST(post({ message: 500 }))).status).toBe(400);
    expect((await POST(post("not json"))).status).toBe(400);
  });
});
