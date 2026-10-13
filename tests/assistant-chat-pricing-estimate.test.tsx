// @vitest-environment jsdom
/**
 * The pricing message the guided request ends with — the exact wording clients
 * see, and what it must never contain (invented numbers, impressions for
 * non-advertising services, agency fees).
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AssistantChat, SERVICE_REQUEST_ORDER_CODE, serviceRequestEstimate } from "../src/components/assistant-chat";

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

function stubChatApi(): void {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes("service-intent")) return Response.json({ data: { optionId: null, source: "none" } });
    if (String(url).includes("service-request")) return Response.json({ data: { orderCode: SERVICE_REQUEST_ORDER_CODE } });
    if (init?.method === "POST") {
      const { message } = JSON.parse(String(init.body)) as { message: string };
      const userMessage: SavedMessage = { id: `m-${saved.length + 1}`, sender: "CLIENT", body: message, language: "ar", createdAt: "2026-10-12T05:01:00.000Z" };
      const reply: SavedMessage = { id: `m-${saved.length + 2}`, sender: "ASSISTANT", body: "أكيد، أي سؤال ثاني؟", language: "ar", createdAt: "2026-10-12T05:01:01.000Z" };
      saved = [...saved, userMessage, reply];
      return Response.json({ data: { conversationId: "conv-1", userMessage, reply, provider: "rules", providerAvailable: false, escalated: false } });
    }
    return Response.json({
      data: { conversationId: "conv-1", customerName: "امجد", email: CLIENT_EMAIL, language: "ar", messages: saved },
      provider: { configured: false },
    });
  }));
}

function estimateBubbles(): Element[] {
  return Array.from(document.querySelectorAll(".chat-messages .chat-message-estimate"));
}

async function openChat(): Promise<void> {
  render(<AssistantChat locale="ar" intent="service_request" />);
  await waitFor(() => expect(document.querySelectorAll(".chat-messages .chat-message").length).toBeGreaterThan(0));
}

function choose(label: string): void {
  fireEvent.click(screen.getByRole("button", { name: label }));
}

/** Answers the four basic questions and waits for the pricing bubble. */
async function answer(choices: string[]): Promise<void> {
  for (const [index, label] of choices.entries()) {
    choose(label);
    await waitFor(() => {
      const context = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? "null");
      expect(context?.answerLog).toHaveLength(index + 1);
    });
  }
  await waitFor(() => expect(estimateBubbles()).toHaveLength(1));
}

const ADS_ANSWERS = ["إعلانات", "متوسط", "أقل من 200$", "🇮🇶 العراق كله"];
const DESIGN_ANSWERS = ["تصميم", "متوسط", "200-500$", "🏙️ بغداد فقط"];

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

describe("client-facing service estimate", () => {
  it("shows the $200 ads estimate with the active days, the results and the contact question", async () => {
    await openChat();
    await answer(ADS_ANSWERS);

    const body = estimateBubbles()[0]!.querySelector("p")?.textContent ?? "";
    expect(body).toBe([
      "ميزانيتك: 200$ 🟡",
      "",
      "💡 تغطي 16 يوم إعلان فعّال",
      "",
      "📊 النتائج المتوقعة:",
      "• الظهور: ~37,000-69,000",
      "• الزيارات: ~370-690",
      "• المهتمون: ~9-17",
      "",
      "كيف تحب يتواصل معك فريق أفق؟",
      "□ 📱 واتساب",
      `□ 📧 إيميل: ${CLIENT_EMAIL}`,
      "□ 💬 إشعار في الموقع",
    ].join("\n"));
    expect(body).not.toContain("صريحين");
    // The guided answers never leave the browser.
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    expect(saved).toEqual([greeting]);
  });

  it("scales the expected results with the budget, keeping the smallest value first", async () => {
    await openChat();
    await answer(["إعلانات", "متوسط", "500-1500$", "🇮🇶 العراق كله"]);

    const body = estimateBubbles()[0]!.querySelector("p")?.textContent ?? "";
    expect(body).toContain("ميزانيتك: 1,500$ 🟢🟢");
    expect(body).toContain("💡 تغطي 30 يوم إعلان فعّال");
    expect(body).toContain("📊 النتائج المتوقعة:");
    expect(body).toContain("• الظهور: ~278,000-517,000");
    expect(body).toContain("• الزيارات: ~2,780-5,170");
    expect(body).toContain("• المهتمون: ~69-129");
    expect(body).not.toContain("تكفي لـ");
  });

  it("shows only the official price for design, with no invented performance stats", async () => {
    await openChat();
    await answer(DESIGN_ANSWERS);

    const body = estimateBubbles()[0]!.querySelector("p")?.textContent ?? "";
    expect(body).toBe([
      "السعر التقديري: ~650-1,560$",
      "",
      "كيف تحب يتواصل معك فريق أفق؟",
      "□ 📱 واتساب",
      `□ 📧 إيميل: ${CLIENT_EMAIL}`,
      "□ 💬 إشعار في الموقع",
    ].join("\n"));
    expect(body).not.toMatch(/الظهور|الزيارات|المهتمون|📊/);
  });

  it("does not invent a price for the unlisted Other service", () => {
    const body = serviceRequestEstimate({ type: "other", size: "small", budget: "under_200", targeting: "iraq_all" }, "ar");
    expect(body).toContain("ما عندنا نطاق سعر معتمد لهذا النوع");
    expect(body).not.toMatch(/\$\d/);
    expect(body).toContain("كيف تحب يتواصل معك فريق أفق؟");
  });

  it("formats the non-ad estimate and the contact choices in English", () => {
    const body = serviceRequestEstimate({ type: "seo", size: "small", budget: "under_200", targeting: "gulf" }, "en", {
      email: "client@example.com",
    });
    expect(body).toContain("Estimated price: ~320-800$");
    expect(body).toContain("How would you like the Ofoq team to contact you?");
    expect(body).toContain("□ 📧 Email: client@example.com");
    expect(body).not.toContain("Impressions");
  });

  it("never exposes agency fees or a budget split in client messages", () => {
    const ads = serviceRequestEstimate({ type: "ads", size: "medium", budget: "under_200", targeting: "iraq_all" }, "ar");
    const design = serviceRequestEstimate({ type: "design", size: "medium", budget: "under_200" }, "ar");
    for (const body of [ads, design]) {
      expect(body).not.toMatch(/أتعاب|عمولة|نصيب|توزيع الميزانية|agency fee|ad spend|commission/i);
    }
    // The order reference appears only in the confirmation, never in the pricing.
    expect(ads).not.toContain(SERVICE_REQUEST_ORDER_CODE);
  });
});
