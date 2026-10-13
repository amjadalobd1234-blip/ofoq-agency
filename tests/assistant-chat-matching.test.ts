/**
 * Hybrid matching of what the client types in the guided service request:
 *
 *   1. exact match against the option id / Arabic label / English label,
 *   2. partial match inside a longer phrase («أريد تصميم»، «تصميم شعار»),
 *   3. AI intent extraction (Groq) when the first two layers fail — the answer
 *      is used only when it names a published option,
 *   4. otherwise the available options are shown again and nothing is saved.
 *
 * Normalisation removes diacritics, unifies the hamza forms and folds the letter
 * variants, so «أعلانات» and «اعلانات» both mean `ads`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseServiceTypeAnswer, resolveServiceIntent } from "../src/lib/agents/service-intent";
import {
  SERVICE_REQUEST_QUESTIONS,
  answerServiceRequest,
  createServiceRequestState,
  matchServiceOption,
  normalizeOptionText,
  serviceRequestClarification,
} from "../src/lib/agents/service-request";
import { callBody, callUrl, clearProviderKeys, completionResponse, errorResponse } from "./ai/completion-mock";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubGroq(answer: string): ReturnType<typeof vi.fn> {
  clearProviderKeys();
  vi.stubEnv("GROQ_API_KEY", "unit-test-key");
  const fetchMock = vi.fn().mockResolvedValue(completionResponse(answer, { model: "openai/gpt-oss-120b" }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("guided request — three-layer option matching", () => {
  it("matches «تصميم» to design with the exact layer", () => {
    expect(matchServiceOption("TYPE", "تصميم")).toBe("design");
    expect(matchServiceOption("TYPE", "إعلانات")).toBe("ads");
    expect(matchServiceOption("TYPE", "سوشيال ميديا")).toBe("social_media");
    expect(matchServiceOption("SIZE", "متوسط")).toBe("medium");
    expect(matchServiceOption("BUDGET", "أقل من 200$")).toBe("under_200");
    expect(matchServiceOption("TARGETING", "🇮🇶 العراق كله")).toBe("iraq_all");
  });

  it("matches «أريد تصميم» with the partial layer", () => {
    expect(matchServiceOption("TYPE", "أريد تصميم")).toBe("design");
    expect(matchServiceOption("TYPE", "أحتاج تصميم شعار لمطعمي")).toBe("design");
    expect(matchServiceOption("TYPE", "أبي تصميم هوية بصرية")).toBe("design");
    expect(matchServiceOption("SIZE", "أعتقد المشروع medium")).toBe("medium");
  });

  it("matches DESIGN regardless of letter case", () => {
    expect(matchServiceOption("TYPE", "DESIGN")).toBe("design");
    expect(matchServiceOption("TYPE", "Design")).toBe("design");
    expect(matchServiceOption("TYPE", "  dEsIgN  ")).toBe("design");
    expect(normalizeOptionText("DESIGN")).toBe("design");
  });

  it("matches «أعلانات» to ads (hamza on the alef)", () => {
    expect(matchServiceOption("TYPE", "أعلانات")).toBe("ads");
    expect(matchServiceOption("TYPE", "إعلانات")).toBe("ads");
    expect(matchServiceOption("TYPE", "آعلانات")).toBe("ads");
    // Normalisation unifies every hamza form.
    expect(normalizeOptionText("أعلانات")).toBe(normalizeOptionText("اعلانات"));
  });

  it("matches «اعلانات» without the hamza", () => {
    expect(matchServiceOption("TYPE", "اعلانات")).toBe("ads");
    expect(matchServiceOption("TYPE", "اريد اعلانات")).toBe("ads");
    // Diacritics, tatweel and trailing punctuation are ignored too.
    expect(matchServiceOption("TYPE", "إعــلانــات.")).toBe("ads");
  });

  it("matches «أحتاج إعلانات» with the partial layer", () => {
    expect(matchServiceOption("TYPE", "أحتاج إعلانات")).toBe("ads");
    expect(matchServiceOption("TYPE", "أريد حملة إعلانات ممولة على فيسبوك")).toBe("ads");
    // A vague word that names no option matches nothing.
    expect(matchServiceOption("TYPE", "ما أدري")).toBeNull();
  });

  it("extracts the intent with the AI for a complex sentence", async () => {
    const fetchMock = stubGroq('{"serviceType":"ads"}');

    const resolution = await resolveServiceIntent(
      "عندي متجر ملابس صغير وأحتاج أوصل لزبائن جدد على الإنترنت بميزانية بسيطة",
    );

    expect(resolution).toEqual({ optionId: "ads", source: "ai", provider: "groq", model: "openai/gpt-oss-120b" });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(callUrl(fetchMock, 0)).toContain("https://api.groq.com/openai/v1/chat/completions");
    const body = callBody(fetchMock, 0);
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content).toContain("serviceType");
    expect(messages.at(-1)?.content).toContain("متجر ملابس");

    // A model answer that names no published option is never used.
    vi.unstubAllGlobals();
    stubGroq('{"serviceType":"influencer_marketing"}');
    expect(await resolveServiceIntent("شي ما موجود")).toEqual({
      optionId: null,
      source: "none",
      provider: "groq",
      model: "openai/gpt-oss-120b",
    });
    expect(parseServiceTypeAnswer('{"serviceType":"ads"}')).toBe("ads");
    expect(parseServiceTypeAnswer("SEO")).toBe("seo");
    expect(parseServiceTypeAnswer('{"serviceType":null}')).toBeNull();
    expect(parseServiceTypeAnswer("not a service")).toBeNull();
  });

  it("shows the available options again for a vague phrase and saves no value", async () => {
    // No provider configured: layer 3 cannot answer either.
    clearProviderKeys();
    const resolution = await resolveServiceIntent("هلا شلونكم");
    expect(resolution.optionId).toBeNull();
    expect(resolution.source).toBe("none");

    const clarification = serviceRequestClarification("TYPE", "ar");
    expect(clarification).toContain("الخيارات المتاحة");
    for (const option of SERVICE_REQUEST_QUESTIONS.TYPE.options) {
      expect(clarification).toContain(option.labelAr);
    }

    // The flow only ever moves through `answerServiceRequest`, which refuses
    // anything that is not one of the offered options.
    const state = createServiceRequestState();
    expect(answerServiceRequest(state, "not-an-option")).toBe(state);
    expect(state.answers).toEqual({});
    expect(state.step).toBe("TYPE");
    expect(matchServiceOption("TYPE", "هلا شلونكم")).toBeNull();

    // A provider that fails behaves exactly like no provider.
    stubGroq("ignored");
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(errorResponse(500, "boom")));
    expect((await resolveServiceIntent("هلا شلونكم")).optionId).toBeNull();
  });
});
