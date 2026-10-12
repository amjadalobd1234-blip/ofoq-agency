// @vitest-environment jsdom
/**
 * The guided «طلب خدمة» conversation after the welcome: TYPE → SIZE →
 * PLATFORMS → DEADLINE → BUDGET → SUMMARY.
 *
 * The real `AssistantChat` renders here with `fetch` replaced by an in-memory
 * /api/chat. Option choices are kept in the request context (sessionStorage),
 * displayed in the chat and never sent to the API; after the summary the flow
 * stops without calling anything.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AssistantChat } from "../src/components/assistant-chat";

const STORAGE_KEY = "ofoq:chat:service-request";
const WELCOME_AR = "أهلاً بك في أفق 👋\nأنا مساعد أفق، راح أساعدك تجهّز طلبك خطوة بخطوة.\n\nأول شي: شنو نوع الخدمة اللي تحتاجها؟ (تصميم / إعلانات / سوشيال ميديا / محتوى / SEO / غير ذلك)";
const WELCOME_EN = "Welcome to Ofoq 👋\nI'm the Ofoq assistant, and I'll help you build your request step by step.\n\nFirst: what type of service do you need? (Design / Ads / Social media / Content / SEO / Other)";
const REPLY = "أكيد، أي سؤال ثاني؟";

const QUESTION_AR = {
  SIZE: "شكد حجم المشروع؟",
  PLATFORMS: "على أي منصات تريد نشتغل؟",
  DEADLINE: "شكد وقت عندك للتسليم؟",
  BUDGET: "شنو الميزانية التقريبية؟",
};

const SUMMARY_AR = "تمام، فهمت طلبك 👌\n\n- الخدمة: تصميم\n- الحجم: متوسط\n- المنصات: Instagram\n- التسليم: مستعجل (3 أيام)\n- الميزانية: 300-700$\n\nخليني أحسب لك سعر تقديري...";

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

/** Labels of the option buttons offered for the current question. */
function shownOptions(): string[] {
  return Array.from(document.querySelectorAll(".chat-service-options button")).map((node) => node.textContent ?? "");
}

function storedContext(): Record<string, unknown> | null {
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

async function answerEverything(): Promise<void> {
  choose("تصميم");
  choose("متوسط");
  choose("Instagram");
  choose("مستعجل (3 أيام)");
  choose("300-700$");
  await waitFor(() => expect(shownBodies()).toContain(SUMMARY_AR));
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

describe("guided service request conversation", () => {
  it("offers the six service types under the welcome and starts at TYPE with no answers", async () => {
    await openChat();

    expect(shownOptions()).toEqual(["تصميم", "إعلانات", "سوشيال ميديا", "محتوى", "SEO", "غير ذلك"]);
    expect(screen.getByRole("group", { name: "شنو نوع الخدمة اللي تحتاجها؟" })).toBeTruthy();
    expect(storedContext()).toMatchObject({ step: "TYPE", answers: {}, answerLog: [] });
  });

  it("saves the chosen type, moves to SIZE and asks the size question with its options", async () => {
    await openChat();

    choose("تصميم");

    await waitFor(() => expect(shownBodies()).toEqual([greeting.body, WELCOME_AR, "تصميم", QUESTION_AR.SIZE]));
    expect(shownOptions()).toEqual(["صغير", "متوسط", "كبير"]);
    expect(storedContext()).toMatchObject({ step: "SIZE", answers: { type: "design" } });
    // The choice is shown as the client's own message.
    const answer = Array.from(document.querySelectorAll(".chat-message")).find((node) => node.querySelector("p")?.textContent === "تصميم");
    expect(answer?.classList.contains("chat-message-client")).toBe(true);
  });

  it("asks every question in order, each with exactly its own options", async () => {
    await openChat();

    choose("سوشيال ميديا");
    await waitFor(() => expect(shownBodies().at(-1)).toBe(QUESTION_AR.SIZE));
    choose("كبير");
    await waitFor(() => expect(shownBodies().at(-1)).toBe(QUESTION_AR.PLATFORMS));
    expect(shownOptions()).toEqual(["Instagram", "TikTok", "Facebook", "Google", "متعدد"]);
    expect(storedContext()).toMatchObject({ step: "PLATFORMS" });

    choose("متعدد");
    await waitFor(() => expect(shownBodies().at(-1)).toBe(QUESTION_AR.DEADLINE));
    expect(shownOptions()).toEqual(["عادي (7 أيام)", "مستعجل (3 أيام)", "مرن (14 يوم)"]);
    expect(storedContext()).toMatchObject({ step: "DEADLINE" });

    choose("مرن (14 يوم)");
    await waitFor(() => expect(shownBodies().at(-1)).toBe(QUESTION_AR.BUDGET));
    expect(shownOptions()).toEqual(["أقل من 300$", "300-700$", "700-1500$", "أكثر من 1500$"]);
    expect(storedContext()).toMatchObject({
      step: "BUDGET",
      answers: { type: "social_media", size: "large", platforms: "multiple", deadline: "flexible_14_days" },
    });
  });

  it("shows the summary after BUDGET with every answer and moves to SUMMARY", async () => {
    await openChat();

    await answerEverything();

    expect(shownBodies()).toEqual([
      greeting.body, WELCOME_AR,
      "تصميم", QUESTION_AR.SIZE,
      "متوسط", QUESTION_AR.PLATFORMS,
      "Instagram", QUESTION_AR.DEADLINE,
      "مستعجل (3 أيام)", QUESTION_AR.BUDGET,
      "300-700$", SUMMARY_AR,
    ]);
    expect(storedContext()).toMatchObject({
      step: "SUMMARY",
      answers: { type: "design", size: "medium", platforms: "instagram", deadline: "urgent_3_days", budget: "300_700" },
    });
  });

  it("stops after the summary: no more options and no API call at any point of the flow", async () => {
    await openChat();
    const callsAfterLoad = vi.mocked(fetch).mock.calls.length;

    await answerEverything();
    // Give any stray effect a chance to fire before asserting nothing happened.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(document.querySelector(".chat-service-options")).toBeNull();
    expect(vi.mocked(fetch).mock.calls.length).toBe(callsAfterLoad);
    expect(postCalls()).toHaveLength(0);
    expect(saved).toEqual([greeting]);
  });

  it("runs the whole flow in English with English questions, options and summary", async () => {
    saved = [{ ...greeting, body: "Welcome to Ofoq.", language: "en" }];
    await openChat("en", WELCOME_EN);

    expect(shownOptions()).toEqual(["Design", "Ads", "Social media", "Content", "SEO", "Other"]);
    choose("SEO");
    await waitFor(() => expect(shownBodies().at(-1)).toBe("How big is the project?"));
    choose("Small");
    await waitFor(() => expect(shownBodies().at(-1)).toBe("Which platforms should we work on?"));
    choose("Google");
    await waitFor(() => expect(shownBodies().at(-1)).toBe("How much time do you have for delivery?"));
    choose("Standard (7 days)");
    await waitFor(() => expect(shownBodies().at(-1)).toBe("What is your approximate budget?"));
    choose("Over $1500");

    await waitFor(() => expect(shownBodies().at(-1)).toBe("Great, I've got your request 👌\n\n- Service: SEO\n- Size: Small\n- Platforms: Google\n- Delivery: Standard (7 days)\n- Budget: Over $1500\n\nLet me work out an estimated price for you..."));
    expect(storedContext()).toMatchObject({ step: "SUMMARY", answers: { type: "seo", size: "small", platforms: "google", deadline: "standard_7_days", budget: "over_1500" } });
  });

  it("continues from the same step after a refresh mid-way", async () => {
    await openChat();
    choose("إعلانات");
    choose("صغير");
    await waitFor(() => expect(shownBodies().at(-1)).toBe(QUESTION_AR.PLATFORMS));
    const before = shownBodies();

    cleanup();
    await openChat();

    expect(shownBodies()).toEqual(before);
    expect(shownOptions()).toEqual(["Instagram", "TikTok", "Facebook", "Google", "متعدد"]);
    choose("TikTok");
    await waitFor(() => expect(shownBodies().at(-1)).toBe(QUESTION_AR.DEADLINE));
    expect(storedContext()).toMatchObject({ step: "DEADLINE", answers: { type: "ads", size: "small", platforms: "tiktok" } });
  });

  it("keeps the summary, without options, after a refresh once the request is complete", async () => {
    await openChat();
    await answerEverything();

    cleanup();
    await openChat();

    expect(shownBodies().filter((body) => body === SUMMARY_AR)).toHaveLength(1);
    expect(shownBodies().at(-1)).toBe(SUMMARY_AR);
    expect(document.querySelector(".chat-service-options")).toBeNull();
    expect(postCalls()).toHaveLength(0);
  });

  it("keeps typed messages going to /api/chat and every guided message in its place", async () => {
    await openChat();
    choose("محتوى");
    await waitFor(() => expect(shownBodies().at(-1)).toBe(QUESTION_AR.SIZE));

    const composer = screen.getByRole("textbox");
    fireEvent.change(composer, { target: { value: "عندي سؤال قبل ما أكمل" } });
    fireEvent.submit(composer.closest("form")!);
    await waitFor(() => expect(shownBodies().at(-1)).toBe(REPLY));
    choose("متوسط");

    const expected = [greeting.body, WELCOME_AR, "محتوى", QUESTION_AR.SIZE, "عندي سؤال قبل ما أكمل", REPLY, "متوسط", QUESTION_AR.PLATFORMS];
    await waitFor(() => expect(shownBodies()).toEqual(expected));
    expect(postCalls().map(([, init]) => JSON.parse(String(init?.body)))).toEqual([{ message: "عندي سؤال قبل ما أكمل" }]);

    // The same order survives a refresh, now that the typed message is saved history.
    cleanup();
    await openChat();
    expect(shownBodies()).toEqual(expected);
  });

  it("starts at TYPE when the stored context predates the questions or its progress does not add up", async () => {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ intent: "service_request", conversationId: "conv-1", afterMessageId: "m-greeting", startedAt: "2026-10-12T04:59:00.000Z" }));
    await openChat();
    expect(shownOptions()).toHaveLength(6);
    choose("تصميم");
    await waitFor(() => expect(storedContext()).toMatchObject({ step: "SIZE", answers: { type: "design" } }));

    cleanup();
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ intent: "service_request", conversationId: "conv-1", afterMessageId: "m-greeting", startedAt: "2026-10-12T04:59:00.000Z", step: "BUDGET", answers: { type: "design" }, answerLog: [] }));
    await openChat();
    expect(shownBodies()).toEqual([greeting.body, WELCOME_AR]);
    expect(shownOptions()).toEqual(["تصميم", "إعلانات", "سوشيال ميديا", "محتوى", "SEO", "غير ذلك"]);
  });
});
