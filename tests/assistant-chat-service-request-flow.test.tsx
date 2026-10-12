// @vitest-environment jsdom
/**
 * The guided service-request order is TYPE → SIZE → PLATFORMS → DEADLINE →
 * BUDGET → BUSINESS_TYPE → PRICE_RANGE → TARGETING → SUMMARY + PRICING.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AssistantChat,
  SERVICE_REQUEST_QUESTIONS,
  SERVICE_REQUEST_STEPS,
  isServiceRequestComplete,
  matchServiceOption,
  serviceRequestEstimate,
} from "../src/components/assistant-chat";

const STORAGE_KEY = "ofoq:chat:service-request";
const WELCOME_AR = "أهلاً بك في أفق 👋\nأنا مساعد أفق، راح أساعدك تجهّز طلبك خطوة بخطوة.\n\nأول شي: شنو نوع الخدمة اللي تحتاجها؟ (تصميم / إعلانات / سوشيال ميديا / محتوى / SEO / غير ذلك)";
const WELCOME_EN = "Welcome to Ofoq 👋\nI'm the Ofoq assistant, and I'll help you build your request step by step.\n\nFirst: what type of service do you need? (Design / Ads / Social media / Content / SEO / Other)";
const REPLY = "أكيد، أي سؤال ثاني؟";

const QUESTION_AR = {
  TYPE: "شنو نوع الخدمة اللي تحتاجها؟",
  SIZE: "شكد حجم المشروع؟",
  PLATFORMS: "على أي منصات تريد نشتغل؟",
  DEADLINE: "شكد وقت عندك للتسليم؟",
  BUDGET: "شنو الميزانية التقريبية؟",
  BUSINESS_TYPE: "شنو نوع مشروعك؟",
  PRICE_RANGE: "شكد سعر منتجاتك تقريباً؟",
  TARGETING: "وين تريد تستهدف إعلانك؟",
};

const ANSWERS_AR = {
  type: "design",
  size: "medium",
  platforms: "instagram",
  deadline: "urgent_3_days",
  budget: "200_500",
  businessType: "online_store",
  priceRange: "50k_150k",
  targeting: "iraq_all",
};

const SUMMARY_AR = "تمام، فهمت طلبك 👌\n\n- الخدمة: تصميم\n- الحجم: متوسط\n- المنصات: Instagram\n- التسليم: مستعجل (3 أيام)\n- الميزانية: 200-500$\n- نوع المشروع: 🛍️ متجر إلكتروني\n- سعر المنتج: 50,000 - 150,000\n- المنطقة المستهدفة: 🇮🇶 العراق كله\n\nخليني أحسب لك تقديراً واضحاً...";
const ESTIMATE_AR = serviceRequestEstimate(ANSWERS_AR, "ar");

interface SavedMessage { id: string; sender: string; body: string; language: string; createdAt: string }

const greeting: SavedMessage = { id: "m-greeting", sender: "ASSISTANT", body: "أهلًا بك في أفق. أنا مساعد أفق، مساعد ذكي تابع للوكالة.", language: "ar", createdAt: "2026-10-12T05:00:00.000Z" };
let saved: SavedMessage[] = [];

function stubChatApi(): void {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const { message } = JSON.parse(String(init.body)) as { message: string };
      const userMessage: SavedMessage = { id: `m-${saved.length + 1}`, sender: "CLIENT", body: message, language: "ar", createdAt: "2026-10-12T05:01:00.000Z" };
      const reply: SavedMessage = { id: `m-${saved.length + 2}`, sender: "ASSISTANT", body: REPLY, language: "ar", createdAt: "2026-10-12T05:01:01.000Z" };
      saved = [...saved, userMessage, reply];
      return Response.json({ data: { conversationId: "conv-1", userMessage, reply, provider: "rules", providerAvailable: false, escalated: false } });
    }
    return Response.json({ data: { conversationId: "conv-1", customerName: "امجد", language: "ar", messages: saved }, provider: { configured: false } });
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

function postCalls() {
  return vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST");
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
  const answers = [
    "تصميم",
    "متوسط",
    "Instagram",
    "مستعجل (3 أيام)",
    "200-500$",
    "🛍️ متجر إلكتروني",
    "50,000 - 150,000",
    "🇮🇶 العراق كله",
  ];
  const followingBodies = [
    QUESTION_AR.SIZE,
    QUESTION_AR.PLATFORMS,
    QUESTION_AR.DEADLINE,
    QUESTION_AR.BUDGET,
    QUESTION_AR.BUSINESS_TYPE,
    QUESTION_AR.PRICE_RANGE,
    QUESTION_AR.TARGETING,
    SUMMARY_AR,
  ];
  for (const [index, answer] of answers.entries()) await chooseAndWait(answer, followingBodies[index]!);
}

beforeEach(() => {
  saved = [greeting];
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
  it("runs the nine steps in the requested order", async () => {
    expect(SERVICE_REQUEST_STEPS).toEqual([
      "TYPE", "SIZE", "PLATFORMS", "DEADLINE", "BUDGET", "BUSINESS_TYPE", "PRICE_RANGE", "TARGETING", "SUMMARY",
    ]);
    await openChat();

    expect(shownOptions()).toEqual(["تصميم", "إعلانات", "سوشيال ميديا", "محتوى", "SEO", "غير ذلك"]);
    await answerEverything();
    expect(shownBodies().slice(-2)).toEqual([SUMMARY_AR, ESTIMATE_AR]);
    expect(storedContext()).toMatchObject({ step: "SUMMARY", answers: ANSWERS_AR });
  });

  it("saves BUSINESS_TYPE and advances to PRICE_RANGE", async () => {
    await openChat();
    await chooseAndWait("تصميم", QUESTION_AR.SIZE);
    await chooseAndWait("متوسط", QUESTION_AR.PLATFORMS);
    await chooseAndWait("Instagram", QUESTION_AR.DEADLINE);
    await chooseAndWait("مستعجل (3 أيام)", QUESTION_AR.BUDGET);
    await chooseAndWait("200-500$", QUESTION_AR.BUSINESS_TYPE);
    expect(shownOptions()).toEqual([
      "🛍️ متجر إلكتروني",
      "🏪 متجر محلي",
      "🍽️ مطعم/مقهى",
      "💼 خدمة (استشارات، تعليم، تصميم)",
      "🏗️ عقارات/سيارات",
      "💎 منتجات فاخرة",
      "🌐 شي ثاني",
    ]);

    await chooseAndWait("🛍️ متجر إلكتروني", QUESTION_AR.PRICE_RANGE);
    expect(storedContext()).toMatchObject({ step: "PRICE_RANGE", answers: { businessType: "online_store" } });
  });

  it("saves PRICE_RANGE and advances to TARGETING", async () => {
    await openChat();
    for (const [answer, next] of [
      ["تصميم", QUESTION_AR.SIZE],
      ["متوسط", QUESTION_AR.PLATFORMS],
      ["Instagram", QUESTION_AR.DEADLINE],
      ["مستعجل (3 أيام)", QUESTION_AR.BUDGET],
      ["200-500$", QUESTION_AR.BUSINESS_TYPE],
      ["🛍️ متجر إلكتروني", QUESTION_AR.PRICE_RANGE],
    ]) await chooseAndWait(answer, next);

    expect(shownOptions()).toEqual([
      "أقل من 50,000 دينار",
      "50,000 - 150,000",
      "150,000 - 500,000",
      "أكثر من 500,000",
    ]);
    await chooseAndWait("50,000 - 150,000", QUESTION_AR.TARGETING);
    expect(storedContext()).toMatchObject({ step: "TARGETING", answers: { priceRange: "50k_150k" } });
  });

  it("saves TARGETING and completes only after the region is selected", async () => {
    await openChat();
    for (const [answer, next] of [
      ["تصميم", QUESTION_AR.SIZE],
      ["متوسط", QUESTION_AR.PLATFORMS],
      ["Instagram", QUESTION_AR.DEADLINE],
      ["مستعجل (3 أيام)", QUESTION_AR.BUDGET],
      ["200-500$", QUESTION_AR.BUSINESS_TYPE],
      ["🛍️ متجر إلكتروني", QUESTION_AR.PRICE_RANGE],
      ["50,000 - 150,000", QUESTION_AR.TARGETING],
    ]) await chooseAndWait(answer, next);

    expect(shownOptions()).toEqual([
      "🇮🇶 العراق كله",
      "🏙️ بغداد فقط",
      "🌊 البصرة فقط",
      "🏙️ بغداد + البصرة + أربيل",
      "🌍 الخليج (السعودية، الإمارات، الكويت)",
      "🌐 عربي عام",
    ]);
    await chooseAndWait("🌊 البصرة فقط", "تمام، فهمت طلبك 👌\n\n- الخدمة: تصميم");
    expect(storedContext()).toMatchObject({ step: "SUMMARY", answers: { targeting: "basra" } });
    expect(isServiceRequestComplete(storedContext()!.answers)).toBe(true);
  });

  it("includes the chosen region in the final summary", async () => {
    await openChat();
    await answerEverything();

    const summary = shownBodies().at(-2)!;
    expect(summary).toContain("- المنطقة المستهدفة: 🇮🇶 العراق كله");
    expect(summary).toContain("- نوع المشروع: 🛍️ متجر إلكتروني");
    expect(summary).toContain("- سعر المنتج: 50,000 - 150,000");
    expect(storedContext()?.answers.targeting).toBe("iraq_all");
  });
});

describe("request persistence and displayed pricing", () => {
  it("keeps guided choices in session storage and never sends them to the chat API", async () => {
    await openChat();
    const callsAfterLoad = vi.mocked(fetch).mock.calls.length;
    await answerEverything();

    expect(document.querySelector(".chat-service-options")).toBeNull();
    expect(vi.mocked(fetch).mock.calls.length).toBe(callsAfterLoad);
    expect(postCalls()).toHaveLength(0);
    expect(saved).toEqual([greeting]);
  });

  it("completes the same questions and summary in English", async () => {
    saved = [{ ...greeting, body: "Welcome to Ofoq.", language: "en" }];
    await openChat("en", WELCOME_EN);

    const sequence: Array<[string, string]> = [
      ["SEO", "How big is the project?"],
      ["Small", "Which platforms should we work on?"],
      ["Google", "How much time do you have for delivery?"],
      ["Standard (7 days)", "What is your approximate budget?"],
      ["Over $1500", "What kind of business do you have?"],
      ["🏗️ Real estate/cars", "How much do your products usually cost?"],
      ["Under IQD 50,000", "Where would you like to target your campaign?"],
      ["🌍 Gulf (Saudi Arabia, UAE, Kuwait)", "Great, I've got your request 👌"],
    ];
    for (const [answer, next] of sequence) await chooseAndWait(answer, next);

    expect(shownBodies().at(-2)).toContain("- Target area: 🌍 Gulf (Saudi Arabia, UAE, Kuwait)");
    expect(shownBodies().at(-1)).toContain("Estimated price: $320-$800");
    expect(storedContext()).toMatchObject({
      step: "SUMMARY",
      answers: {
        type: "seo", size: "small", platforms: "google", deadline: "standard_7_days", budget: "over_1500",
        businessType: "real_estate", priceRange: "under_50k", targeting: "gulf",
      },
    });
  });

  it("continues at the current question after a refresh", async () => {
    await openChat();
    await chooseAndWait("إعلانات", QUESTION_AR.SIZE);
    await chooseAndWait("صغير", QUESTION_AR.PLATFORMS);
    cleanup();
    await openChat();

    expect(shownBodies().at(-1)).toBe(QUESTION_AR.PLATFORMS);
    expect(shownOptions()).toEqual(["Instagram", "TikTok", "Facebook", "Google", "متعدد"]);
    await chooseAndWait("TikTok", QUESTION_AR.DEADLINE);
    expect(storedContext()).toMatchObject({ step: "DEADLINE", answers: { type: "ads", size: "small", platforms: "tiktok" } });
  });

  it("keeps the complete summary and estimate after a refresh", async () => {
    await openChat();
    await answerEverything();
    cleanup();
    await openChat();

    expect(shownBodies().filter((body) => body === SUMMARY_AR)).toHaveLength(1);
    expect(shownBodies().filter((body) => body === ESTIMATE_AR)).toHaveLength(1);
    expect(shownBodies().slice(-2)).toEqual([SUMMARY_AR, ESTIMATE_AR]);
    expect(document.querySelector(".chat-service-options")).toBeNull();
    expect(postCalls()).toHaveLength(0);
  });
});

describe("typed answers in the guided conversation", () => {
  it("accepts an option id, an English label, and Iraqi-market option ids as typed answers", async () => {
    await openChat();
    type("  Design ");
    await waitFor(() => expect(storedContext()).toMatchObject({ step: "SIZE", answers: { type: "design" } }));
    type("MEDIUM");
    await waitFor(() => expect(storedContext()).toMatchObject({ step: "PLATFORMS", answers: { size: "medium" } }));
    type("instagram.");
    await waitFor(() => expect(storedContext()).toMatchObject({ step: "DEADLINE", answers: { platforms: "instagram" } }));
    type("standard_7_days");
    await waitFor(() => expect(storedContext()).toMatchObject({ step: "BUDGET", answers: { deadline: "standard_7_days" } }));
    type("under_200");
    await waitFor(() => expect(storedContext()).toMatchObject({ step: "BUSINESS_TYPE", answers: { budget: "under_200" } }));
    type("online_store");
    await waitFor(() => expect(storedContext()).toMatchObject({ step: "PRICE_RANGE", answers: { businessType: "online_store" } }));
    type("50k_150k");
    await waitFor(() => expect(storedContext()).toMatchObject({ step: "TARGETING", answers: { priceRange: "50k_150k" } }));
    type("basra");
    await waitFor(() => expect(storedContext()).toMatchObject({ step: "SUMMARY", answers: { targeting: "basra" } }));
    expect(postCalls()).toHaveLength(0);

    expect(matchServiceOption("BUSINESS_TYPE", "online_store")).toBe("online_store");
    expect(matchServiceOption("PRICE_RANGE", "50k_150k")).toBe("50k_150k");
    expect(matchServiceOption("TARGETING", "basra")).toBe("basra");
    expect(matchServiceOption("TYPE", "اعلانات")).toBe("ads");
    expect(matchServiceOption("SIZE", "متوسط؟")).toBe("medium");
  });

  it("sends text that is not an option to the assistant without advancing the step", async () => {
    await openChat();
    type("كبير");
    await waitFor(() => expect(shownBodies().at(-1)).toBe(REPLY));
    type("أريد تصميم شعار");
    await waitFor(() => expect(postCalls()).toHaveLength(2));

    expect(postCalls().map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { message: "كبير" },
      { message: "أريد تصميم شعار" },
    ]);
    expect(storedContext()).toMatchObject({ step: "TYPE", answers: {}, answerLog: [] });
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
  it("keeps the prompt and required choices for project type, product price and target area", () => {
    expect(SERVICE_REQUEST_QUESTIONS.BUSINESS_TYPE.question.ar).toBe("شنو نوع مشروعك؟");
    expect(SERVICE_REQUEST_QUESTIONS.BUSINESS_TYPE.options.map((option) => option.id)).toEqual([
      "online_store", "local_store", "restaurant", "service", "real_estate", "luxury", "other",
    ]);
    expect(SERVICE_REQUEST_QUESTIONS.PRICE_RANGE.question.ar).toBe("شكد سعر منتجاتك تقريباً؟");
    expect(SERVICE_REQUEST_QUESTIONS.PRICE_RANGE.options.map((option) => option.id)).toEqual([
      "under_50k", "50k_150k", "150k_500k", "over_500k",
    ]);
    expect(SERVICE_REQUEST_QUESTIONS.TARGETING.question.ar).toBe("وين تريد تستهدف إعلانك؟");
    expect(SERVICE_REQUEST_QUESTIONS.TARGETING.options.map((option) => option.id)).toEqual([
      "iraq_all", "baghdad", "basra", "three_cities", "gulf", "arabic_global",
    ]);
  });
});
