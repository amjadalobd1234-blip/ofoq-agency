// @vitest-environment jsdom
/**
 * The guided service-request order is:
 *
 *   TYPE → SIZE → BUDGET → TARGETING → SUMMARY + PRICING → CONTACT
 *
 * and nothing else is asked: platforms, delivery time, project type and product
 * price were removed, the delivery is planned as normal, and the number of
 * platforms is inferred from the budget.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AssistantChat,
  SERVICE_REQUEST_BASIC_STEPS,
  SERVICE_REQUEST_QUESTIONS,
  SERVICE_REQUEST_ORDER_CODE,
  SERVICE_REQUEST_STEPS,
  SERVICE_REQUEST_WELCOME,
  isServiceRequestComplete,
  matchServiceOption,
  serviceRequestClarification,
  serviceRequestEstimate,
  serviceRequestSummary,
} from "../src/components/assistant-chat";

const STORAGE_KEY = "ofoq:chat:service-request";
const WELCOME_AR = SERVICE_REQUEST_WELCOME.ar;
const WELCOME_EN = SERVICE_REQUEST_WELCOME.en;
const CLIENT_EMAIL = "client@example.com";
const REPLY = "أكيد، أي سؤال ثاني؟";

const QUESTION_AR = {
  TYPE: "شنو نوع الخدمة اللي تحتاجها؟",
  SIZE: "شكد حجم المشروع؟",
  BUDGET: "شنو الميزانية التقريبية؟",
  TARGETING: "وين تريد تستهدف إعلانك؟",
  CONTACT: "كيف تحب يتواصل معك فريق أفق؟",
};

const ANSWERS_AR = { type: "ads", size: "medium", budget: "under_200", targeting: "iraq_all" };

const SUMMARY_AR = serviceRequestSummary(ANSWERS_AR, "ar");
const ESTIMATE_AR = serviceRequestEstimate(ANSWERS_AR, "ar", { email: CLIENT_EMAIL });

interface SavedMessage { id: string; sender: string; body: string; language: string; createdAt: string }

const greeting: SavedMessage = { id: "m-greeting", sender: "ASSISTANT", body: "أهلًا بك في أفق. أنا مساعد أفق، مساعد ذكي تابع للوكالة.", language: "ar", createdAt: "2026-10-12T05:00:00.000Z" };
let saved: SavedMessage[] = [];
/** What /api/chat/service-intent answers in this test. */
let intentOptionId: string | null = null;

function stubChatApi(): void {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes("service-intent")) {
      return Response.json({ data: { optionId: intentOptionId, source: intentOptionId ? "ai" : "none" } });
    }
    if (String(url).includes("service-request")) {
      return Response.json({ data: { orderCode: SERVICE_REQUEST_ORDER_CODE } });
    }
    if (init?.method === "POST") {
      const { message } = JSON.parse(String(init.body)) as { message: string };
      const userMessage: SavedMessage = { id: `m-${saved.length + 1}`, sender: "CLIENT", body: message, language: "ar", createdAt: "2026-10-12T05:01:00.000Z" };
      const reply: SavedMessage = { id: `m-${saved.length + 2}`, sender: "ASSISTANT", body: REPLY, language: "ar", createdAt: "2026-10-12T05:01:01.000Z" };
      saved = [...saved, userMessage, reply];
      return Response.json({ data: { conversationId: "conv-1", userMessage, reply, provider: "rules", providerAvailable: false, escalated: false } });
    }
    return Response.json({
      data: { conversationId: "conv-1", customerName: "امجد", email: CLIENT_EMAIL, language: "ar", messages: saved },
      provider: { configured: false },
    });
  }));
}

function shownBodies(): string[] {
  return Array.from(document.querySelectorAll(".chat-messages .chat-message p")).map((node) => node.textContent ?? "");
}

function shownOptions(): string[] {
  return Array.from(document.querySelectorAll(".chat-service-options button")).map((node) => node.textContent ?? "");
}

function storedContext(): Record<string, any> | null {
  return JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? "null");
}

/** POSTs to exactly `path` (so /api/chat does not match /api/chat/service-request). */
function postCalls(path?: string) {
  return vi.mocked(fetch).mock.calls.filter(([url, init]) => init?.method === "POST" && (!path || new URL(String(url), "http://localhost").pathname === path));
}

async function openChat(locale: "ar" | "en" = "ar", welcome = WELCOME_AR): Promise<void> {
  render(<AssistantChat locale={locale} intent="service_request" />);
  await waitFor(() => expect(shownBodies()).toContain(welcome));
}

function choose(label: string): void {
  fireEvent.click(screen.getByRole("button", { name: label }));
}

function type(text: string): void {
  const composer = screen.getByRole("textbox");
  fireEvent.change(composer, { target: { value: text } });
  fireEvent.submit(composer.closest("form")!);
}

async function chooseAndWait(label: string, expectedNextBody: string): Promise<void> {
  choose(label);
  await waitFor(() => expect(shownBodies().some((body) => body.includes(expectedNextBody))).toBe(true));
}

async function answerEverything(): Promise<void> {
  const answers = ["إعلانات", "متوسط", "أقل من 200$", "🇮🇶 العراق كله", `📧 إيميل: ${CLIENT_EMAIL}`];
  const following = [QUESTION_AR.SIZE, QUESTION_AR.BUDGET, QUESTION_AR.TARGETING, SUMMARY_AR, "تم حفظ طلبك ✅"];
  for (const [index, answer] of answers.entries()) await chooseAndWait(answer, following[index]!);
}

beforeEach(() => {
  saved = [greeting];
  intentOptionId = null;
  Element.prototype.scrollIntoView = vi.fn();
  stubChatApi();
});

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("guided service request order and saved answers", () => {
  it("asks only TYPE, SIZE, BUDGET and TARGETING before the summary and the pricing", async () => {
    expect(SERVICE_REQUEST_BASIC_STEPS).toEqual(["TYPE", "SIZE", "BUDGET", "TARGETING"]);
    expect(SERVICE_REQUEST_STEPS.slice(0, 6)).toEqual(["TYPE", "SIZE", "BUDGET", "TARGETING", "SUMMARY", "CONTACT"]);
    // The removed questions are gone from the flow and from the definitions.
    expect(Object.keys(SERVICE_REQUEST_QUESTIONS)).toEqual(["TYPE", "SIZE", "BUDGET", "TARGETING", "CONTACT"]);
    expect(SERVICE_REQUEST_STEPS).not.toContain("PLATFORMS");
    expect(SERVICE_REQUEST_STEPS).not.toContain("DEADLINE");

    await openChat();
    expect(shownOptions()).toEqual(["تصميم", "إعلانات", "سوشيال ميديا", "محتوى", "SEO", "غير ذلك"]);

    await chooseAndWait("إعلانات", QUESTION_AR.SIZE);
    await chooseAndWait("متوسط", QUESTION_AR.BUDGET);
    await chooseAndWait("أقل من 200$", QUESTION_AR.TARGETING);
    await chooseAndWait("🇮🇶 العراق كله", SUMMARY_AR);

    // Summary then pricing, in that order, and only then the contact channel.
    expect(shownBodies().filter((body) => body === SUMMARY_AR)).toHaveLength(1);
    expect(shownBodies().some((body) => body === ESTIMATE_AR)).toBe(true);
    expect(shownOptions()).toEqual(["📱 واتساب", `📧 إيميل: ${CLIENT_EMAIL}`, "💬 إشعار في الموقع"]);
    expect(isServiceRequestComplete(storedContext()?.answers)).toBe(true);
  });

  it("infers the platform scope from the budget and never asks for it", async () => {
    await openChat();
    await answerEverything();

    const context = storedContext();
    expect(context?.answers).toMatchObject(ANSWERS_AR);
    // $200 → a single platform; the pricing message never mentions a platform question.
    expect(context?.answerLog.map((event: any) => event.step)).toEqual(["TYPE", "SIZE", "BUDGET", "TARGETING", "CONTACT"]);
  });

  it("saves the guided choices in session storage and never sends them to the chat API", async () => {
    await openChat();
    const callsAfterLoad = vi.mocked(fetch).mock.calls.length;
    await answerEverything();

    expect(storedContext()?.step).toBe("DONE");
    expect(storedContext()?.answers).toMatchObject({ ...ANSWERS_AR, contact: "email" });
    // Only the completion report leaves the browser; the answers themselves never do.
    expect(postCalls("/api/chat")).toHaveLength(0);
    expect(postCalls("/api/chat/service-intent")).toHaveLength(0);
    expect(postCalls("/api/chat/service-request")).toHaveLength(1);
    expect(saved).toEqual([greeting]);
    expect(vi.mocked(fetch).mock.calls.length).toBe(callsAfterLoad + 1)
  });

  it("completes the same four questions in English", async () => {
    saved = [{ ...greeting, body: "Welcome to Ofoq.", language: "en" }];
    await openChat("en", WELCOME_EN);

    const sequence: Array<[string, string]> = [
      ["SEO", SERVICE_REQUEST_QUESTIONS.SIZE.question.en],
      ["Small", SERVICE_REQUEST_QUESTIONS.BUDGET.question.en],
      ["Over $1500", SERVICE_REQUEST_QUESTIONS.TARGETING.question.en],
      ["🌍 Gulf (Saudi Arabia, UAE, Kuwait)", serviceRequestSummary({ type: "seo", size: "small", budget: "over_1500", targeting: "gulf" }, "en")],
      ["📧 Email: " + CLIENT_EMAIL, "Your request was saved ✅"],
    ];
    for (const [answer, next] of sequence) await chooseAndWait(answer, next);

    expect(storedContext()?.answers).toMatchObject({
      type: "seo", size: "small", budget: "over_1500", targeting: "gulf", contact: "email",
    });
    // SEO is not an advertising service: a price is quoted, impressions are not.
    expect(shownBodies().some((body) => body.includes("Estimated price"))).toBe(true);
    expect(shownBodies().some((body) => body.includes("Impressions"))).toBe(false);
  });

  it("continues at the current question after a refresh", async () => {
    await openChat();
    await chooseAndWait("تصميم", QUESTION_AR.SIZE);
    await chooseAndWait("صغير", QUESTION_AR.BUDGET);
    cleanup();
    await openChat();

    expect(shownBodies().at(-1)).toBe(QUESTION_AR.BUDGET);
    expect(shownOptions()).toEqual(["أقل من 200$", "200-500$", "500-1500$", "أكثر من 1500$"]);
    await chooseAndWait("200-500$", QUESTION_AR.TARGETING);
    expect(storedContext()?.answers).toMatchObject({ type: "design", size: "small", budget: "200_500" });
  });

  it("keeps the summary, the pricing and the confirmation after a refresh", async () => {
    await openChat();
    await answerEverything();
    cleanup();
    await openChat();

    expect(shownBodies().filter((body) => body === SUMMARY_AR)).toHaveLength(1);
    expect(shownBodies().filter((body) => body === ESTIMATE_AR)).toHaveLength(1);
    expect(shownBodies().some((body) => body.includes(SERVICE_REQUEST_ORDER_CODE))).toBe(true);
    expect(document.querySelector(".chat-service-options")).toBeNull();
    expect(shownOptions()).toEqual([]);
  });
});

describe("typed answers in the guided conversation", () => {
  it("accepts an option id, an Arabic label, an English label and hamza variants", async () => {
    await openChat();
    type("  Design ");
    await waitFor(() => expect(storedContext()?.answers.type).toBe("design"));
    type("MEDIUM");
    await waitFor(() => expect(storedContext()?.answers.size).toBe("medium"));
    type("under_200");
    await waitFor(() => expect(storedContext()?.answers.budget).toBe("under_200"));
    type("أريد استهداف العراق كله");
    await waitFor(() => expect(storedContext()?.answers.targeting).toBe("iraq_all"));

    // The flow is now on the contact channel, and nothing was sent to the API.
    expect(storedContext()?.step).toBe("SUMMARY");
    expect(postCalls("/api/chat")).toHaveLength(0);
    expect(matchServiceOption("TYPE", "اعلانات")).toBe("ads");
    expect(matchServiceOption("SIZE", "متوسط؟")).toBe("medium");
    expect(matchServiceOption("TARGETING", "أريد استهداف العراق كله")).toBe("iraq_all");
  });

  it("asks the AI for the service type when the phrase is not an option, and uses a valid answer", async () => {
    await openChat();
    intentOptionId = "ads";

    type("عندي متجر ملابس وأحتاج أوصل لزبائن جدد بميزانية بسيطة");

    await waitFor(() => expect(storedContext()?.answers.type).toBe("ads"));
    expect(postCalls("/api/chat/service-intent")).toHaveLength(1);
    expect(JSON.parse(String(postCalls("/api/chat/service-intent")[0]?.[1]?.body))).toEqual({
      message: "عندي متجر ملابس وأحتاج أوصل لزبائن جدد بميزانية بسيطة",
    });
    // A real option was extracted, so the message itself was not sent to the assistant.
    expect(postCalls("/api/chat")).toHaveLength(0);
    expect(storedContext()?.step).toBe("SIZE");

    // The same phrase with no intent available asks the client to pick an option.
    cleanup();
    window.sessionStorage.clear();
    await openChat();
    intentOptionId = null;
    type("عندي متجر ملابس وأحتاج أوصل لزبائن جدد بميزانية بسيطة");
    await waitFor(() => expect(shownBodies().some((body) => body.includes("الخيارات المتاحة"))).toBe(true));

    expect(shownBodies().some((body) => body === serviceRequestClarification("TYPE", "ar"))).toBe(true);
    expect(storedContext()?.answers).toEqual({});
    expect(storedContext()?.step).toBe("TYPE");
  });

  it("shows the options again for a vague phrase and keeps the question open", async () => {
    await openChat();

    type("هلا شلونكم");

    await waitFor(() => expect(shownBodies().some((body) => body.includes("الخيارات المتاحة"))).toBe(true));
    expect(shownOptions()).toEqual(["تصميم", "إعلانات", "سوشيال ميديا", "محتوى", "SEO", "غير ذلك"]);
    expect(storedContext()?.step).toBe("TYPE");
    expect(storedContext()?.answers).toEqual({});

    // The conversation is not stalled: the assistant still answers the message,
    // and the «pick one of these» note stays the newest thing on screen.
    await waitFor(() => expect(shownBodies()).toContain(REPLY));
    expect(shownBodies().at(-1)).toContain("الخيارات المتاحة");
    // And a real option still moves the request forward afterwards.
    await chooseAndWait("إعلانات", QUESTION_AR.SIZE);
    expect(storedContext()?.answers.type).toBe("ads");
  });

  it("restarts old or inconsistent stored progress at TYPE", async () => {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
      intent: "service_request",
      conversationId: "conv-1",
      afterMessageId: "m-greeting",
      startedAt: "2026-10-12T04:59:00.000Z",
      step: "SUMMARY",
      answers: { type: "design" },
      answerLog: [],
    }));
    await openChat();
    expect(shownBodies()).toEqual([greeting.body, WELCOME_AR]);
    expect(shownOptions()).toEqual(["تصميم", "إعلانات", "سوشيال ميديا", "محتوى", "SEO", "غير ذلك"]);
    expect(storedContext()).toMatchObject({ step: "TYPE", answers: {}, answerLog: [] });
  });
});

describe("guided question definitions", () => {
  it("keeps the four basic questions plus the contact channel", () => {
    expect(SERVICE_REQUEST_QUESTIONS.TYPE.question.ar).toBe("شنو نوع الخدمة اللي تحتاجها؟");
    expect(SERVICE_REQUEST_QUESTIONS.SIZE.question.ar).toBe("شكد حجم المشروع؟");
    expect(SERVICE_REQUEST_QUESTIONS.BUDGET.question.ar).toBe("شنو الميزانية التقريبية؟");
    expect(SERVICE_REQUEST_QUESTIONS.TARGETING.question.ar).toBe("وين تريد تستهدف إعلانك؟");
    expect(SERVICE_REQUEST_QUESTIONS.CONTACT.question.ar).toBe("كيف تحب يتواصل معك فريق أفق؟");
    expect(SERVICE_REQUEST_QUESTIONS.CONTACT.options.map((option) => option.id)).toEqual(["whatsapp", "email", "website"]);
    expect(SERVICE_REQUEST_QUESTIONS.TARGETING.options.map((option) => option.id)).toEqual([
      "iraq_all", "baghdad", "basra", "three_cities", "gulf", "arabic_global",
    ]);
  });
});
