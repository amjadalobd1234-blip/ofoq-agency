// @vitest-environment jsdom
/**
 * «اطلب خدمة جديدة» on /dashboard opens /chat?intent=service_request.
 *
 * The real `AssistantChat` renders here; only `fetch` is replaced by a tiny
 * stand-in for /api/chat that keeps the saved conversation in memory. The
 * service-request welcome is displayed, never saved, so these tests pin where
 * it appears, what sessionStorage holds, and that a refresh does not ask the
 * first question again. Free text that matches no option is answered by the
 * assistant AND followed by the clarification message with the available
 * options — the request itself is never advanced by a guess.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AssistantChat, SERVICE_REQUEST_WELCOME } from "../src/components/assistant-chat";

const WELCOME_AR = SERVICE_REQUEST_WELCOME.ar;
const WELCOME_EN = SERVICE_REQUEST_WELCOME.en;
const STORAGE_KEY = "ofoq:chat:service-request";
const REPLY = "ممتاز، خلينا نعرف تفاصيل أكثر عن التصميم.";
/** Free text that names no option, so it goes to the assistant like any message. */
const FREE_TEXT = "هلا شلونكم";
const CLARIFICATION_START = "ما قدرت أحدد الخيار";

interface SavedMessage { id: string; sender: string; body: string; language: string; createdAt: string }

/** The greeting `ofoq_client_chat_bootstrap` saves as the first message of a new conversation. */
const greeting: SavedMessage = { id: "m-greeting", sender: "ASSISTANT", body: "أهلًا بك في أفق. أنا مساعد أفق، مساعد ذكي تابع للوكالة.", language: "ar", createdAt: "2026-10-12T05:00:00.000Z" };

/** What the database holds for this client's open conversation. */
let saved: SavedMessage[] = [];
let conversationId = "conv-1";

function stubChatApi(): void {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes("service-intent")) return Response.json({ data: { optionId: null, source: "none" } });
    if (init?.method === "POST") {
      const { message } = JSON.parse(String(init.body)) as { message: string };
      const userMessage: SavedMessage = { id: `m-${saved.length + 1}`, sender: "CLIENT", body: message, language: "ar", createdAt: "2026-10-12T05:01:00.000Z" };
      const reply: SavedMessage = { id: `m-${saved.length + 2}`, sender: "ASSISTANT", body: REPLY, language: "ar", createdAt: "2026-10-12T05:01:01.000Z" };
      saved = [...saved, userMessage, reply];
      return Response.json({ data: { conversationId, userMessage, reply, provider: "rules", providerAvailable: false, escalated: false } });
    }
    return Response.json({ data: { conversationId, customerName: "امجد", email: "client@example.com", language: "ar", messages: saved }, provider: { configured: false } });
  }));
}

/** Message bodies in the order the client sees them (the typing indicator has no <p>). */
function shownBodies(): string[] {
  return Array.from(document.querySelectorAll(".chat-messages .chat-message p")).map((node) => node.textContent ?? "");
}

function storedContext(): Record<string, unknown> | null {
  return JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? "null");
}

beforeEach(() => {
  saved = [greeting];
  conversationId = "conv-1";
  // jsdom has no layout engine; the chat scrolls its tail into view after each message.
  Element.prototype.scrollIntoView = vi.fn();
  stubChatApi();
});

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("chat opened from «اطلب خدمة جديدة» (?intent=service_request)", () => {
  it("shows the service-request welcome right after the saved greeting and stores the context", async () => {
    render(<AssistantChat locale="ar" intent="service_request" />);

    await waitFor(() => expect(shownBodies()).toEqual([greeting.body, WELCOME_AR]));
    expect(storedContext()).toMatchObject({ intent: "service_request", conversationId: "conv-1", afterMessageId: "m-greeting", step: "TYPE" });
    // The hint note stays; the generic starter suggestions give way to the first question's options.
    expect(document.querySelector(".chat-context-note")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "أريد معرفة الأسعار" })).toBeNull();
    expect(screen.getByRole("button", { name: "تصميم" })).toBeTruthy();
  });

  it("keeps the welcome above the client's answer, and a refresh does not ask again", async () => {
    render(<AssistantChat locale="ar" intent="service_request" />);
    await waitFor(() => expect(shownBodies()).toEqual([greeting.body, WELCOME_AR]));

    const composer = screen.getByRole("textbox");
    fireEvent.change(composer, { target: { value: FREE_TEXT } });
    fireEvent.submit(composer.closest("form")!);
    // The assistant answers, and the request shows its options again without
    // advancing: nothing was guessed and nothing was saved.
    await waitFor(() => expect(shownBodies()).toContain(REPLY));
    expect(shownBodies().at(-1)).toContain(CLARIFICATION_START);
    expect(storedContext()).toMatchObject({ step: "TYPE", answers: {} });
    // The welcome is displayed only; the API was asked to save the client's message alone.
    const post = vi.mocked(fetch).mock.calls.find(([url, init]) => init?.method === "POST" && String(url).endsWith("/api/chat"));
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ message: FREE_TEXT });

    // Refresh: the page loads again with the same URL and the answer is now saved history.
    cleanup();
    render(<AssistantChat locale="ar" intent="service_request" />);
    await waitFor(() => expect(shownBodies()).toContain(FREE_TEXT));
    expect(shownBodies().filter((body) => body === WELCOME_AR)).toHaveLength(1);
    expect(shownBodies().indexOf(WELCOME_AR)).toBeLessThan(shownBodies().indexOf(FREE_TEXT));
  });

  it("starts after the latest saved message for a client with an existing conversation", async () => {
    saved = [greeting, { id: "m-old-1", sender: "CLIENT", body: "سؤال قديم", language: "ar", createdAt: "2026-10-01T09:00:00.000Z" }, { id: "m-old-2", sender: "ASSISTANT", body: "رد قديم", language: "ar", createdAt: "2026-10-01T09:00:01.000Z" }];

    render(<AssistantChat locale="ar" intent="service_request" />);

    await waitFor(() => expect(shownBodies()).toEqual([greeting.body, "سؤال قديم", "رد قديم", WELCOME_AR]));
    expect(storedContext()).toMatchObject({ conversationId: "conv-1", afterMessageId: "m-old-2" });
  });

  it("starts a new request when the stored context belongs to another conversation", async () => {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ intent: "service_request", conversationId: "conv-closed", afterMessageId: "m-elsewhere", startedAt: "2026-10-11T10:00:00.000Z" }));

    render(<AssistantChat locale="ar" intent="service_request" />);

    await waitFor(() => expect(shownBodies()).toEqual([greeting.body, WELCOME_AR]));
    expect(storedContext()).toMatchObject({ conversationId: "conv-1", afterMessageId: "m-greeting" });
  });

  it("uses the English welcome in the English interface", async () => {
    const englishGreeting: SavedMessage = { ...greeting, body: "Welcome to Ofoq. I am the agency’s AI assistant.", language: "en" };
    saved = [englishGreeting];

    render(<AssistantChat locale="en" intent="service_request" />);

    await waitFor(() => expect(shownBodies()).toEqual([englishGreeting.body, WELCOME_EN]));
  });

  it("still shows the welcome when the browser blocks sessionStorage", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("blocked", "SecurityError"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("blocked", "SecurityError"); });

    render(<AssistantChat locale="ar" intent="service_request" />);

    await waitFor(() => expect(shownBodies()).toEqual([greeting.body, WELCOME_AR]));
  });
});

describe("chat opened without the intent (/chat)", () => {
  it("is unchanged: only the saved conversation, even after a service request in this tab", async () => {
    const earlier = { intent: "service_request", conversationId: "conv-1", afterMessageId: "m-greeting", startedAt: "2026-10-12T04:59:00.000Z" };
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(earlier));

    render(<AssistantChat locale="ar" />);

    await waitFor(() => expect(shownBodies()).toEqual([greeting.body]));
    expect(document.querySelector(".chat-context-note")).toBeNull();
    expect(storedContext()).toEqual(earlier);
  });
});
