// @vitest-environment jsdom
/**
 * The «اطلب خدمة جديدة» entry point on /chat itself. The assistant points the
 * client to this button, so it must be on the page at all times: «ابدأ طلب خدمة»
 * in a fresh conversation (only the greeting), «اطلب خدمة جديدة» once the client
 * has already written in it. Both link to /chat?intent=service_request.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AssistantChat } from "../src/components/assistant-chat";

interface SavedMessage { id: string; sender: string; body: string; language: string; createdAt: string }

const greeting: SavedMessage = { id: "m-greeting", sender: "ASSISTANT", body: "أهلًا بك في أفق.", language: "ar", createdAt: "2026-10-12T05:00:00.000Z" };
const clientMessage: SavedMessage = { id: "m-1", sender: "CLIENT", body: "تحديد الميزانية", language: "ar", createdAt: "2026-10-12T05:01:00.000Z" };
const reply: SavedMessage = { id: "m-2", sender: "ASSISTANT", body: "لعرض الأسعار…", language: "ar", createdAt: "2026-10-12T05:01:01.000Z" };

function stubChatApi(messages: SavedMessage[]): void {
  vi.stubGlobal("fetch", vi.fn(async () =>
    Response.json({ data: { conversationId: "conv-1", customerName: "امجد", email: null, language: "ar", messages }, provider: { configured: false } }),
  ));
}

function ctaLink(): HTMLAnchorElement | null {
  return document.querySelector<HTMLAnchorElement>(".chat-service-cta a");
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("/chat — service request button", () => {
  it("shows «ابدأ طلب خدمة» when no conversation has been started yet", async () => {
    stubChatApi([greeting]);
    render(<AssistantChat locale="ar" />);

    await waitFor(() => expect(ctaLink()).not.toBeNull());
    expect(ctaLink()?.textContent).toContain("ابدأ طلب خدمة");
    expect(ctaLink()?.getAttribute("href")).toBe("/chat?intent=service_request");
  });

  it("shows «اطلب خدمة جديدة» when the client already has a conversation", async () => {
    stubChatApi([greeting, clientMessage, reply]);
    render(<AssistantChat locale="ar" />);

    await waitFor(() => expect(ctaLink()).not.toBeNull());
    expect(ctaLink()?.textContent).toContain("اطلب خدمة جديدة");
    expect(ctaLink()?.getAttribute("href")).toBe("/chat?intent=service_request");
    expect(screen.queryByText("ابدأ طلب خدمة")).toBeNull();
  });
});
