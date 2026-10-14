/**
 * The AI intent layer of the guided service request.
 *
 * The system used to save what it was told and understand nothing else: a client
 * who typed «بصرا», «أريد أشتغل بالبصرة», «بغداد والبصرة», «بريد» or «المكان»
 * was shown the options again, because the deterministic matcher only
 * recognises a message that literally contains an option.
 *
 * Every selection step now resolves in two layers, exercised here end to end
 * through `resolveStepIntent()` with a stubbed Groq:
 *
 *   1. the rules (exact, then partial) — «البصرة» and «السعودية» cost no call,
 *   2. `POST /api/chat/step-intent` — the model names one published option of
 *      the step plus a confidence, and `acceptStepIntent()` keeps it only when
 *      the option is real AND the confidence is at least 0.7.
 *
 * Anything else is `null`: the options are shown again and nothing is saved.
 * The route itself is exercised at the end, as an HTTP endpoint.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildStepIntentPrompt,
  parseStepIntentAnswer,
  resolveStepIntent,
  stepIntentOptions,
} from "../src/lib/agents/step-intent";
import {
  SERVICE_REQUEST_QUESTIONS,
  STEP_INTENT_MIN_CONFIDENCE,
  acceptStepIntent,
  answerServiceRequest,
  createServiceRequestState,
  currentQuestionStep,
  matchServiceOption,
  serviceRequestClarification,
  type ServiceRequestQuestionStep,
  type ServiceRequestState,
} from "../src/lib/agents/service-request";
import { callBody, callUrl, clearProviderKeys, completionResponse, errorResponse } from "./ai/completion-mock";

vi.mock("@/lib/supabase/route-auth", () => ({
  requireSupabaseUser: () =>
    Promise.resolve({
      client: { rpc: () => Promise.resolve({ data: null, error: null }) },
      user: { id: "user-1", email: "client@example.test" },
      requestId: "corr-1",
      finalize: (response: Response) => response,
    }),
}));

const { POST } = await import("../src/app/api/chat/step-intent/route");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Groq answers `answer` to the next completion; nothing leaves the process. */
function stubGroq(answer: string): ReturnType<typeof vi.fn> {
  clearProviderKeys();
  vi.stubEnv("GROQ_API_KEY", "unit-test-key");
  const fetchMock = vi.fn().mockResolvedValue(completionResponse(answer, { model: "openai/gpt-oss-120b" }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** A fetch that fails the test if the rules were enough and no AI call was due. */
function forbidProviderCalls(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(() => Promise.reject(new Error("no provider call expected")));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const FIRST_ANSWER: Record<"TYPE" | "SIZE" | "BUDGET" | "TARGETING", string> = {
  TYPE: "ads",
  SIZE: "medium",
  BUDGET: "under_200",
  TARGETING: "iraq_all",
};

/** A request whose open question is `step` (CONTACT is the question on SUMMARY). */
function stateAt(step: ServiceRequestQuestionStep): ServiceRequestState {
  let state = createServiceRequestState();
  for (const open of ["TYPE", "SIZE", "BUDGET", "TARGETING"] as const) {
    if (currentQuestionStep(state) === step) break;
    state = answerServiceRequest(state, FIRST_ANSWER[open]);
  }
  return state;
}

/** Stores a resolved option the way the chat does, and returns the new state. */
function store(state: ServiceRequestState, optionId: string | null): ServiceRequestState {
  if (!optionId) return state;
  return answerServiceRequest(state, optionId);
}

describe("the guided request understands what the client types (rules → AI intent)", () => {
  beforeEach(() => {
    clearProviderKeys();
  });

  it("1. «البصرة» → basra, read by the rules without spending an AI call", async () => {
    const fetchMock = forbidProviderCalls();

    const resolution = await resolveStepIntent("TARGETING", "البصرة");

    expect(resolution).toEqual({ optionId: "basra", confidence: 1, source: "local" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(matchServiceOption("TARGETING", "البصرة")).toBe("basra");

    const next = store(stateAt("TARGETING"), resolution.optionId);
    expect(next.answers.targeting).toBe("basra");
    expect(next.step).toBe("SUMMARY");
  });

  it("2. «بصرا» → basra (a typo only the intent layer reads)", async () => {
    const fetchMock = stubGroq('{"match":"basra","confidence":0.93}');

    const resolution = await resolveStepIntent("TARGETING", "بصرا");

    expect(resolution).toEqual({
      optionId: "basra",
      confidence: 0.93,
      source: "ai",
      provider: "groq",
      model: "openai/gpt-oss-120b",
    });
    // The model was given the step, the question on screen and every option.
    expect(callUrl(fetchMock, 0)).toContain("https://api.groq.com/openai/v1/chat/completions");
    const body = callBody(fetchMock, 0);
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content).toContain("Step: TARGETING");
    expect(messages[0]?.content).toContain("وين تريد تستهدف إعلانك؟");
    for (const option of SERVICE_REQUEST_QUESTIONS.TARGETING.options) {
      expect(messages[0]?.content).toContain(option.id);
    }
    expect(messages.at(-1)?.content).toBe("بصرا");

    expect(store(stateAt("TARGETING"), resolution.optionId).answers.targeting).toBe("basra");
  });

  it("3. «أريد أشتغل بالبصرة» → basra (the choice inside a longer sentence)", async () => {
    stubGroq('{"match":"basra","confidence":0.95}');

    const resolution = await resolveStepIntent("TARGETING", "أريد أشتغل بالبصرة");

    expect(resolution).toMatchObject({ optionId: "basra", source: "ai" });
    expect(resolution.confidence).toBeGreaterThanOrEqual(STEP_INTENT_MIN_CONFIDENCE);
    // The rules alone do not read it: the option label is «البصرة فقط».
    expect(matchServiceOption("TARGETING", "أريد أشتغل بالبصرة")).toBeNull();
    expect(store(stateAt("TARGETING"), resolution.optionId).answers.targeting).toBe("basra");
  });

  it("4. «بغداد والبصرة» → three_cities (the option that covers both)", async () => {
    stubGroq('{"match":"three_cities","confidence":0.88}');

    const resolution = await resolveStepIntent("TARGETING", "بغداد والبصرة");

    expect(resolution).toMatchObject({ optionId: "three_cities", source: "ai" });
    expect(store(stateAt("TARGETING"), resolution.optionId).answers.targeting).toBe("three_cities");
  });

  it("5. «بريد» → email (the contact channel by another name)", async () => {
    stubGroq('{"match":"email","confidence":0.9}');

    const resolution = await resolveStepIntent("CONTACT", "بريد");

    expect(resolution).toMatchObject({ optionId: "email", source: "ai" });
    expect(matchServiceOption("CONTACT", "بريد")).toBeNull();

    const next = store(stateAt("CONTACT"), resolution.optionId);
    expect(next.answers.contact).toBe("email");
    expect(next.step).toBe("DONE");
  });

  it("6. «المكان» → website, even when the model answers «site»", async () => {
    // `site` is not a published id; the gate maps it to the in-app option
    // instead of refusing an answer that is plainly the right one.
    stubGroq('{"match":"site","confidence":0.85}');

    const resolution = await resolveStepIntent("CONTACT", "المكان");

    expect(resolution).toMatchObject({ optionId: "website", source: "ai" });
    expect(store(stateAt("CONTACT"), resolution.optionId).answers.contact).toBe("website");
  });

  it("7. «الموقع» → website (the rules read it out of the option label), a paraphrase → the AI", async () => {
    // The option is «💬 إشعار في الموقع», so the partial layer already reads the
    // single word — no completion spent.
    const fetchMock = forbidProviderCalls();
    expect(await resolveStepIntent("CONTACT", "الموقع")).toEqual({
      optionId: "website",
      confidence: 1,
      source: "local",
    });
    expect(fetchMock).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
    stubGroq('{"match":"website","confidence":0.87}');
    const resolution = await resolveStepIntent("CONTACT", "أريد التنبيه يجيني هون بالمنصة");

    expect(resolution).toMatchObject({ optionId: "website", source: "ai" });
    expect(store(stateAt("CONTACT"), resolution.optionId).answers.contact).toBe("website");
  });

  it("8. «كل العراق» → iraq_all", async () => {
    stubGroq('{"match":"iraq_all","confidence":0.96}');

    const resolution = await resolveStepIntent("TARGETING", "كل العراق");

    expect(resolution).toMatchObject({ optionId: "iraq_all", source: "ai" });
    expect(store(stateAt("TARGETING"), resolution.optionId).answers.targeting).toBe("iraq_all");
  });

  it("9. «السعودية» → gulf, and a longer Gulf sentence goes through the AI", async () => {
    // The rules read the single country name (the option label lists it).
    const fetchMock = forbidProviderCalls();
    expect(await resolveStepIntent("TARGETING", "السعودية")).toEqual({
      optionId: "gulf",
      confidence: 1,
      source: "local",
    });
    expect(fetchMock).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
    stubGroq('{"match":"gulf","confidence":0.82}');
    const resolution = await resolveStepIntent("TARGETING", "أبي أوصل لزبائن بالرياض وجدة");
    expect(resolution).toMatchObject({ optionId: "gulf", source: "ai" });
    expect(store(stateAt("TARGETING"), resolution.optionId).answers.targeting).toBe("gulf");
  });

  it("10. an ambiguous message → null: the options are shown again, nothing is saved", async () => {
    stubGroq('{"match":null,"confidence":0}');

    const state = stateAt("TARGETING");
    const resolution = await resolveStepIntent("TARGETING", "ما أدري شلون أشرحلك الموضوع");

    expect(resolution.optionId).toBeNull();
    expect(resolution.source).toBe("none");
    // The state is untouched and the flow stays on the same question.
    expect(store(state, resolution.optionId)).toBe(state);
    expect(state.answers.targeting).toBeUndefined();
    expect(state.step).toBe("TARGETING");

    // The fallback the chat shows: the question's own options, all of them.
    const clarification = serviceRequestClarification("TARGETING", "ar");
    expect(clarification).toContain("الخيارات المتاحة");
    for (const option of SERVICE_REQUEST_QUESTIONS.TARGETING.options) {
      expect(clarification).toContain(option.labelAr);
    }
  });
});

describe("the gate: only a real option, only when the model is sure", () => {
  it("keeps an answer at or above the threshold and refuses one below it", () => {
    expect(STEP_INTENT_MIN_CONFIDENCE).toBe(0.7);
    expect(acceptStepIntent("TARGETING", "basra", 0.7)).toBe("basra");
    expect(acceptStepIntent("TARGETING", "basra", 0.69)).toBeNull();
    expect(acceptStepIntent("TARGETING", "basra", 0)).toBeNull();
    // No confidence stated at all is a refusal, never a silent accept.
    expect(acceptStepIntent("TARGETING", "basra", null)).toBeNull();
    expect(acceptStepIntent("TARGETING", "basra", undefined)).toBeNull();
    expect(acceptStepIntent("TARGETING", "basra", "not a number")).toBeNull();
  });

  it("understands a label or an alias, and never an unpublished value", () => {
    expect(acceptStepIntent("TARGETING", "🌊 البصرة فقط", 0.9)).toBe("basra");
    expect(acceptStepIntent("CONTACT", "site", 0.9)).toBe("website");
    expect(acceptStepIntent("CONTACT", "gmail", 0.9)).toBe("email");
    expect(acceptStepIntent("TARGETING", "gcc", 0.9)).toBe("gulf");
    expect(acceptStepIntent("TARGETING", "erbil_only", 0.99)).toBeNull();
    expect(acceptStepIntent("TARGETING", "mars", 0.99)).toBeNull();
    // A real option of another step is still not an answer to this one.
    expect(acceptStepIntent("CONTACT", "basra", 0.99)).toBeNull();
    expect(acceptStepIntent("TARGETING", null, 0.99)).toBeNull();
  });

  it("refuses a low-confidence or invented answer from the provider", async () => {
    stubGroq('{"match":"basra","confidence":0.4}');
    expect((await resolveStepIntent("TARGETING", "يمكن هناك")).optionId).toBeNull();

    vi.unstubAllGlobals();
    stubGroq('{"match":"erbil_only","confidence":0.99}');
    expect((await resolveStepIntent("TARGETING", "أربيل وحدها")).optionId).toBeNull();
  });

  it("behaves like no answer when the provider fails or nothing is configured", async () => {
    // No provider key at all: the rules stand alone and no call is made.
    clearProviderKeys();
    const resolution = await resolveStepIntent("TARGETING", "بصرا");
    expect(resolution).toEqual({ optionId: null, confidence: null, source: "none" });

    // A provider that errors is the same thing: never a guess, never a throw.
    stubGroq("ignored");
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(errorResponse(500, "boom")));
    expect((await resolveStepIntent("TARGETING", "بصرا")).optionId).toBeNull();
  });
});

describe("reading the model's answer", () => {
  it("parses JSON, fenced JSON, other key names and a bare id", () => {
    expect(parseStepIntentAnswer('{"match":"basra","confidence":0.95}')).toEqual({ match: "basra", confidence: 0.95 });
    expect(parseStepIntentAnswer('```json\n{"match":"gulf","confidence":0.8}\n```')).toEqual({
      match: "gulf",
      confidence: 0.8,
    });
    expect(parseStepIntentAnswer('{"option":"email","score":"0.75"}')).toEqual({ match: "email", confidence: 0.75 });
    expect(parseStepIntentAnswer("basra")).toEqual({ match: "basra", confidence: 1 });
    expect(parseStepIntentAnswer('{"match":null,"confidence":0}')).toEqual({ match: null, confidence: 0 });
    expect(parseStepIntentAnswer("I think the client means Basra.")).toEqual({ match: null, confidence: null });
    expect(parseStepIntentAnswer("")).toEqual({ match: null, confidence: null });
  });

  it("offers the model the published options only, and honours a narrowing", () => {
    expect(stepIntentOptions("CONTACT").map((option) => option.value)).toEqual(["whatsapp", "email", "website"]);
    expect(stepIntentOptions("CONTACT", ["email", "website"]).map((option) => option.value)).toEqual([
      "email",
      "website",
    ]);
    // Unpublished values are dropped; nothing valid left means the full list.
    expect(stepIntentOptions("CONTACT", ["mars"]).map((option) => option.value)).toEqual([
      "whatsapp",
      "email",
      "website",
    ]);

    const prompt = buildStepIntentPrompt(
      "CONTACT",
      "بريد",
      stepIntentOptions("CONTACT"),
      "en",
    );
    expect(prompt.system).toContain("Step: CONTACT");
    expect(prompt.system).toContain("How would you like the Ofoq team to contact you?");
    expect(prompt.system).toContain('{"match":"<value>","confidence":<number from 0 to 1>}');
    expect(prompt.system).toContain("- email →");
    expect(prompt.user).toBe("بريد");
  });
});

describe("POST /api/chat/step-intent", () => {
  interface IntentResponse {
    data: { match: string | null; confidence: number | null; source: string; provider: string | null; minConfidence: number };
  }

  function post(body: unknown): Request {
    return new Request("http://localhost/api/chat/step-intent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  async function ask(body: unknown): Promise<{ status: number; payload: IntentResponse | { error: string } }> {
    const response = await POST(post(body));
    return { status: response.status, payload: (await response.json()) as IntentResponse | { error: string } };
  }

  it("answers a phrase the rules cannot read, through Groq", async () => {
    stubGroq('{"match":"basra","confidence":0.95}');

    const { status, payload } = await ask({
      step: "TARGETING",
      message: "أريد أشتغل بالبصرة",
      language: "ar",
      options: SERVICE_REQUEST_QUESTIONS.TARGETING.options.map((option) => ({
        value: option.id,
        labelAr: option.labelAr,
      })),
    });

    expect(status).toBe(200);
    expect(payload).toEqual({
      data: { match: "basra", confidence: 0.95, source: "ai", provider: "groq", minConfidence: 0.7 },
    });
  });

  it("answers «البصرة» from the rules and spends no completion", async () => {
    const fetchMock = forbidProviderCalls();

    const { payload } = await ask({ step: "TARGETING", message: "البصرة" });

    expect(payload).toEqual({ data: { match: "basra", confidence: 1, source: "local", provider: null, minConfidence: 0.7 } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never offers the model an option the flow cannot store", async () => {
    const fetchMock = stubGroq('{"match":"mars","confidence":0.99}');

    const { payload } = await ask({ step: "TARGETING", message: "عندي فكرة ثانية", options: [{ value: "mars" }] });

    // The invented value is refused, and the prompt only listed published ones.
    expect((payload as IntentResponse).data.match).toBeNull();
    const system = (callBody(fetchMock, 0).messages as Array<{ content: string }>)[0]?.content ?? "";
    expect(system).toContain("iraq_all");
    expect(system).not.toContain("mars");
  });

  it("refuses an unusable body instead of guessing", async () => {
    expect((await ask({ step: "TARGETING" })).status).toBe(400);
    expect((await ask({ step: "PLATFORMS", message: "البصرة" })).status).toBe(400);
    expect((await ask({ step: "TARGETING", message: "" })).status).toBe(400);
    expect((await ask("not json")).status).toBe(400);
  });
});
