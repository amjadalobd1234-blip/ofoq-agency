// @vitest-environment jsdom
/**
 * Contact-channel step of the guided service request, driven through the real
 * chat component:
 *
 *   📧 email        → the channel is saved immediately, the order reference shown
 *   📱 WhatsApp     → the number is requested, validated and saved
 *   💬 in-app       → the client is told an in-site notification is enabled
 *
 * The number must have 10–15 digits and start with 07, +964 or 964; anything
 * else is refused with «الرقم غير صحيح، حاول مرة ثانية» and nothing is stored.
 */
import { createElement } from "react";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AssistantChat, SERVICE_REQUEST_ORDER_CODE, serviceRequestConfirmation } from "../src/components/assistant-chat";
import { isValidWhatsappNumber, submitWhatsappNumber, createServiceRequestState, answerServiceRequest } from "../src/lib/agents/service-request";

const STORAGE_KEY = "ofoq:chat:service-request";
const CLIENT_EMAIL = "client@example.com";

interface SavedMessage { id: string; sender: string; body: string; language: string; createdAt: string }

const greeting: SavedMessage = {
  id: "m-greeting",
  sender: "ASSISTANT",
  body: "أهلًا بك في أفق. أنا مساعد أفق، مساعد ذكي تابع للوكالة.",
  language: "ar",
  createdAt: "2026-10-12T05:00:00.000Z",
};
let saved: SavedMessage[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** /api/chat, /api/chat/service-intent and /api/chat/service-request, stubbed. */
function stubChatApi(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("service-intent")) {
        // No provider configured in these tests: no intent is extracted.
        return jsonResponse({ data: { optionId: null, source: "none" } });
      }
      if (String(url).includes("service-request")) {
        return jsonResponse({ data: { orderCode: SERVICE_REQUEST_ORDER_CODE, alertId: "alert-1" } });
      }
      if (init?.method === "POST") {
        const { message } = JSON.parse(String(init.body)) as { message: string };
        const userMessage: SavedMessage = { id: `m-${saved.length + 1}`, sender: "CLIENT", body: message, language: "ar", createdAt: "2026-10-12T05:01:00.000Z" };
        const reply: SavedMessage = { id: `m-${saved.length + 2}`, sender: "ASSISTANT", body: "أكيد، أي سؤال ثاني؟", language: "ar", createdAt: "2026-10-12T05:01:01.000Z" };
        saved = [...saved, userMessage, reply];
        return jsonResponse({ data: { conversationId: "conv-1", userMessage, reply, provider: "rules", providerAvailable: false, escalated: false } });
      }
      return jsonResponse({
        data: { conversationId: "conv-1", customerName: "امجد", email: CLIENT_EMAIL, language: "ar", messages: saved },
        provider: { configured: false },
      });
    }),
  );
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

async function openChat(): Promise<void> {
  render(createElement(AssistantChat, { locale: "ar", intent: "service_request" }));
  await waitFor(() => expect(shownOptions()).toContain("تصميم"));
}

function choose(label: string): void {
  fireEvent.click(screen.getByRole("button", { name: label }));
}

function type(text: string): void {
  const composer = screen.getByRole("textbox");
  fireEvent.change(composer, { target: { value: text } });
  fireEvent.submit(composer.closest("form")!);
}

/** Answers TYPE → SIZE → BUDGET → TARGETING and waits for the pricing message. */
async function answerBasicQuestions(): Promise<void> {
  choose("إعلانات");
  await waitFor(() => expect(shownOptions()).toContain("متوسط"));
  choose("متوسط");
  await waitFor(() => expect(shownOptions()).toContain("أقل من 200$"));
  choose("أقل من 200$");
  await waitFor(() => expect(shownOptions()).toContain("🇮🇶 العراق كله"));
  choose("🇮🇶 العراق كله");
  await waitFor(() => expect(document.querySelector(".chat-message-estimate")).not.toBeNull());
  await waitFor(() => expect(shownOptions()).toContain(`📧 إيميل: ${CLIENT_EMAIL}`));
}

function postCalls(path: string) {
  return vi.mocked(fetch).mock.calls.filter(([url, init]) => init?.method === "POST" && String(url).includes(path));
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

describe("guided request — contact channel", () => {
  it("saves the email channel immediately and shows the order reference", async () => {
    await openChat();
    await answerBasicQuestions();

    // The pricing message carries the registered address on the email line.
    const estimate = document.querySelector(".chat-message-estimate p")?.textContent ?? "";
    expect(estimate).toContain(`□ 📧 إيميل: ${CLIENT_EMAIL}`);

    choose(`📧 إيميل: ${CLIENT_EMAIL}`);

    await waitFor(() => expect(storedContext()?.step).toBe("DONE"));
    expect(storedContext()?.answers).toMatchObject({ type: "ads", size: "medium", budget: "under_200", targeting: "iraq_all", contact: "email" });
    await waitFor(() => expect(shownBodies().some((body) => body.includes(SERVICE_REQUEST_ORDER_CODE))).toBe(true));
    const confirmation = shownBodies().find((body) => body.includes(SERVICE_REQUEST_ORDER_CODE))!;
    expect(confirmation).toContain("سيتواصل معك فريق أفق على البريد المسجل");
    expect(confirmation).toContain(CLIENT_EMAIL);
    // The completed request is reported so the alert and the owner email exist.
    await waitFor(() => expect(postCalls("service-request")).toHaveLength(1));
  });

  it("asks for the phone number when WhatsApp is chosen", async () => {
    await openChat();
    await answerBasicQuestions();

    choose("📱 واتساب");

    await waitFor(() => expect(storedContext()?.step).toBe("PHONE"));
    expect(storedContext()?.answers.contact).toBe("whatsapp");
    expect(storedContext()?.answers.phone).toBeUndefined();
    // The prompt is shown and the channel buttons give way to the number input.
    await waitFor(() => expect(shownBodies().some((body) => body.includes("ابعث لي رقم واتساب"))).toBe(true));
    expect(shownOptions()).toEqual([]);
    expect(postCalls("service-request")).toHaveLength(0);
  });

  it("saves a valid WhatsApp number and confirms it with the order reference", async () => {
    await openChat();
    await answerBasicQuestions();
    choose("📱 واتساب");
    await waitFor(() => expect(storedContext()?.step).toBe("PHONE"));

    type("07701234567");

    await waitFor(() => expect(storedContext()?.step).toBe("DONE"));
    expect(storedContext()?.answers.phone).toBe("07701234567");
    const confirmation = shownBodies().find((body) => body.includes(SERVICE_REQUEST_ORDER_CODE))!;
    expect(confirmation).toContain("تم حفظ رقمك");
    expect(confirmation).toContain("واتساب");
    expect(confirmation).toContain("07701234567");
    await waitFor(() => expect(postCalls("service-request")).toHaveLength(1));

    // The accepted formats of the rule: 07…, 964…, +964…, 10–15 digits.
    for (const number of ["0770123456", "+964770123456", "9647701234567", "+964 770 123 4567"]) {
      expect(isValidWhatsappNumber(number)).toBe(true);
    }
    for (const number of ["12345", "077012345678901234", "05501234567", "", "+9657701234"]) {
      expect(isValidWhatsappNumber(number)).toBe(false);
    }
  });

  it("refuses an invalid number, asks again and stores nothing", async () => {
    await openChat();
    await answerBasicQuestions();
    choose("📱 واتساب");
    await waitFor(() => expect(storedContext()?.step).toBe("PHONE"));

    type("12345");

    await waitFor(() => expect(shownBodies().some((body) => body === "الرقم غير صحيح، حاول مرة ثانية")).toBe(true));
    expect(storedContext()?.step).toBe("PHONE");
    expect(storedContext()?.answers.phone).toBeUndefined();
    expect(storedContext()?.phoneError).toBe(true);
    expect(postCalls("service-request")).toHaveLength(0);
    expect(shownBodies().some((body) => body.includes("ابعث لي رقم واتساب"))).toBe(true);

    // The valid number that follows is accepted and clears the error.
    type("07701234567");
    await waitFor(() => expect(storedContext()?.step).toBe("DONE"));
    expect(storedContext()?.answers.phone).toBe("07701234567");
    expect(storedContext()?.phoneError).toBe(false);

    // The pure flow behaves the same way.
    const state = answerServiceRequest(createServiceRequestState(), "ads", "2026-10-12T06:00:00.000Z");
    const rejected = submitWhatsappNumber(state, "12345", "2026-10-12T06:01:00.000Z");
    expect(rejected.error).toBe("الرقم غير صحيح، حاول مرة ثانية");
    expect(rejected.state.answers.phone).toBeUndefined();
  });

  it("enables the in-app notification channel and confirms it", async () => {
    await openChat();
    await answerBasicQuestions();

    choose("💬 إشعار في الموقع");

    await waitFor(() => expect(storedContext()?.step).toBe("DONE"));
    expect(storedContext()?.answers.contact).toBe("website");
    const confirmation = shownBodies().find((body) => body.includes(SERVICE_REQUEST_ORDER_CODE))!;
    expect(confirmation).toContain("ستستلم إشعاراً في الموقع");
    expect(confirmation).toContain(SERVICE_REQUEST_ORDER_CODE);
    await waitFor(() => expect(postCalls("service-request")).toHaveLength(1));
    const payload = JSON.parse(String(postCalls("service-request")[0]?.[1]?.body));
    expect(payload.answers).toMatchObject({ contact: "website", type: "ads" });
    // The order reference comes from the saved request; before the server
    // answers the confirmation says the save is in progress, and a failure is
    // stated plainly — never a silent success.
    expect(serviceRequestConfirmation({ contact: "website" }, "ar", { submission: { status: "saved", orderCode: SERVICE_REQUEST_ORDER_CODE } })).toContain(SERVICE_REQUEST_ORDER_CODE);
    expect(serviceRequestConfirmation({ contact: "website" }, "ar")).toContain("جارٍ حفظ طلبك");
    expect(serviceRequestConfirmation({ contact: "website" }, "ar", { submission: { status: "failed", error: "السبب: X" } })).toContain("تعذر حفظ طلبك ❌");
  });
});
