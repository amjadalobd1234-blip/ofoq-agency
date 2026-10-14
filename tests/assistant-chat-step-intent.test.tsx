// @vitest-environment jsdom
/**
 * The AI intent layer inside the real chat component.
 *
 * `tests/service-request-step-intent.test.ts` covers the layer itself (rules →
 * Groq → gate). This file drives the actual `AssistantChat` to prove the wiring:
 * a typed answer the rules cannot read is sent to `POST /api/chat/step-intent`
 * with the open step and its published options, an accepted answer is stored and
 * the flow moves on, and a weak or invented answer leaves the question open with
 * the options shown again — exactly as before the layer existed.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AssistantChat, SERVICE_REQUEST_ORDER_CODE } from "../src/components/assistant-chat";

const STORAGE_KEY = "ofoq:chat:service-request";
const CLIENT_EMAIL = "client@example.com";
const REPLY = "أكيد، أي سؤال ثاني؟";
const QUESTION_AR = {
  SIZE: "شكد حجم المشروع؟",
  BUDGET: "شنو الميزانية التقريبية؟",
  TARGETING: "وين تريد تستهدف إعلانك؟",
};

interface SavedMessage { id: string; sender: string; body: string; language: string; createdAt: string }

const greeting: SavedMessage = { id: "m-greeting", sender: "ASSISTANT", body: "أهلًا بك في أفق.", language: "ar", createdAt: "2026-10-12T05:00:00.000Z" };
let saved: SavedMessage[] = [];
/** What /api/chat/step-intent answers in this test. */
let stepIntent: { match: string | null; confidence: number | null } = { match: null, confidence: null };

function stubChatApi(): void {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(String(url), "http://localhost").pathname;
    if (path === "/api/chat/service-intent") return Response.json({ data: { optionId: null, source: "none" } });
    if (path === "/api/chat/step-intent") {
      return Response.json({
        data: { ...stepIntent, source: stepIntent.match ? "ai" : "none", provider: "groq", minConfidence: 0.7 },
      });
    }
    if (path === "/api/chat/service-request") return Response.json({ data: { orderCode: SERVICE_REQUEST_ORDER_CODE } });
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

/** POSTs to exactly `path` (so /api/chat does not match /api/chat/step-intent). */
function postCalls(path: string) {
  return vi.mocked(fetch).mock.calls.filter(([url, init]) => init?.method === "POST" && new URL(String(url), "http://localhost").pathname === path);
}

function choose(label: string): void {
  fireEvent.click(screen.getByRole("button", { name: label }));
}

function type(text: string): void {
  const composer = screen.getByRole("textbox");
  fireEvent.change(composer, { target: { value: text } });
  fireEvent.submit(composer.closest("form")!);
}

async function openAt(step: "TYPE" | "SIZE" | "TARGETING"): Promise<void> {
  render(<AssistantChat locale="ar" intent="service_request" />);
  await waitFor(() => expect(shownOptions()).toContain("تصميم"));
  if (step === "TYPE") return;
  choose("إعلانات");
  await waitFor(() => expect(shownBodies().some((body) => body.includes(QUESTION_AR.SIZE))).toBe(true));
  if (step === "SIZE") return;
  choose("متوسط");
  await waitFor(() => expect(shownBodies().some((body) => body.includes(QUESTION_AR.BUDGET))).toBe(true));
  choose("أقل من 200$");
  await waitFor(() => expect(shownBodies().some((body) => body.includes(QUESTION_AR.TARGETING))).toBe(true));
}

beforeEach(() => {
  saved = [greeting];
  stepIntent = { match: null, confidence: null };
  Element.prototype.scrollIntoView = vi.fn();
  stubChatApi();
});

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("guided request — the AI intent layer in the chat", () => {
  it("understands «أريد أشتغل بالبصرة» at TARGETING and stores basra", async () => {
    await openAt("TARGETING");
    stepIntent = { match: "basra", confidence: 0.95 };

    type("أريد أشتغل بالبصرة");

    await waitFor(() => expect(storedContext()?.answers.targeting).toBe("basra"));
    const [call] = postCalls("/api/chat/step-intent");
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      step: "TARGETING",
      message: "أريد أشتغل بالبصرة",
      language: "ar",
      options: [
        { value: "iraq_all", labelAr: "🇮🇶 العراق كله", labelEn: "🇮🇶 All Iraq" },
        { value: "baghdad", labelAr: "🏙️ بغداد فقط", labelEn: "🏙️ Baghdad only" },
        { value: "basra", labelAr: "🌊 البصرة فقط", labelEn: "🌊 Basra only" },
        { value: "three_cities", labelAr: "🏙️ بغداد + البصرة + أربيل", labelEn: "🏙️ Baghdad + Basra + Erbil" },
        { value: "gulf", labelAr: "🌍 الخليج (السعودية، الإمارات، الكويت)", labelEn: "🌍 Gulf (Saudi Arabia, UAE, Kuwait)" },
        { value: "arabic_global", labelAr: "🌐 عربي عام", labelEn: "🌐 General Arabic-speaking audience" },
      ],
    });
    // A real option was understood, so the message was not sent to the assistant
    // and the summary/pricing followed the answer.
    expect(postCalls("/api/chat")).toHaveLength(0);
    expect(storedContext()?.step).toBe("SUMMARY");
  });

  it("understands «بريد» at CONTACT and completes the request on the email channel", async () => {
    await openAt("TARGETING");
    choose("🇮🇶 العراق كله");
    await waitFor(() => expect(shownOptions()).toContain(`📧 إيميل: ${CLIENT_EMAIL}`));
    stepIntent = { match: "email", confidence: 0.9 };

    type("بريد");

    await waitFor(() => expect(storedContext()?.answers.contact).toBe("email"));
    expect(storedContext()?.step).toBe("DONE");
    expect(JSON.parse(String(postCalls("/api/chat/step-intent")[0]?.[1]?.body))).toMatchObject({
      step: "CONTACT",
      message: "بريد",
    });
  });

  it("covers the SIZE step too: «العمل بسيط» → small", async () => {
    await openAt("SIZE");
    stepIntent = { match: "small", confidence: 0.8 };

    type("العمل بسيط");

    await waitFor(() => expect(storedContext()?.answers.size).toBe("small"));
    expect(postCalls("/api/chat/step-intent")).toHaveLength(1);
    expect(storedContext()?.step).toBe("BUDGET");
  });

  it("keeps the question open when the model is not sure enough", async () => {
    await openAt("TARGETING");
    stepIntent = { match: "basra", confidence: 0.4 };

    type("يمكن هناك");

    await waitFor(() => expect(shownBodies().some((body) => body.includes("الخيارات المتاحة"))).toBe(true));
    expect(storedContext()?.answers.targeting).toBeUndefined();
    expect(storedContext()?.step).toBe("TARGETING");
    // The options of the open question stay on screen, and the assistant still
    // answers the message — nothing was guessed.
    expect(shownOptions()).toContain("🌊 البصرة فقط");
    await waitFor(() => expect(shownBodies()).toContain(REPLY));
  });

  it("refuses an option the step does not offer, however confident the model is", async () => {
    await openAt("TARGETING");
    stepIntent = { match: "erbil_only", confidence: 0.99 };

    type("أربيل وحدها");

    await waitFor(() => expect(shownBodies().some((body) => body.includes("الخيارات المتاحة"))).toBe(true));
    expect(storedContext()?.answers.targeting).toBeUndefined();
    expect(storedContext()?.step).toBe("TARGETING");
    // A real option still moves the request forward afterwards.
    choose("🌊 البصرة فقط");
    await waitFor(() => expect(storedContext()?.answers.targeting).toBe("basra"));
  });

  it("spends no completion when the rules already read the answer", async () => {
    await openAt("TARGETING");
    stepIntent = { match: "gulf", confidence: 0.99 };

    type("البصرة");

    await waitFor(() => expect(storedContext()?.answers.targeting).toBe("basra"));
    expect(postCalls("/api/chat/step-intent")).toHaveLength(0);
  });
});
