// @vitest-environment jsdom
/** Final client-facing estimates for the guided service request. */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AssistantChat, serviceRequestEstimate } from "../src/components/assistant-chat";

const STORAGE_KEY = "ofoq:chat:service-request";
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
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const { message } = JSON.parse(String(init.body)) as { message: string };
      const userMessage: SavedMessage = { id: `m-${saved.length + 1}`, sender: "CLIENT", body: message, language: "ar", createdAt: "2026-10-12T05:01:00.000Z" };
      const reply: SavedMessage = { id: `m-${saved.length + 2}`, sender: "ASSISTANT", body: "أكيد، أي سؤال ثاني؟", language: "ar", createdAt: "2026-10-12T05:01:01.000Z" };
      saved = [...saved, userMessage, reply];
      return Response.json({ data: { conversationId: "conv-1", userMessage, reply, provider: "rules", providerAvailable: false, escalated: false } });
    }
    return Response.json({ data: { conversationId: "conv-1", customerName: "امجد", language: "ar", messages: saved }, provider: { configured: false } });
  }));
}

function estimateBubbles(): Element[] {
  return Array.from(document.querySelectorAll(".chat-messages .chat-message-estimate"));
}

function postCalls() {
  return vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST");
}

async function openChat(): Promise<void> {
  render(<AssistantChat locale="ar" intent="service_request" />);
  await waitFor(() => expect(document.querySelectorAll(".chat-messages .chat-message").length).toBeGreaterThan(0));
}

function choose(label: string): void {
  fireEvent.click(screen.getByRole("button", { name: label }));
}

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

const ADS_WEAK_ANSWERS = [
  "إعلانات", "متوسط", "Instagram", "عادي (7 أيام)", "أقل من 200$",
  "🛍️ متجر إلكتروني", "أقل من 50,000 دينار", "🇮🇶 العراق كله",
];

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
  it("shows the conservative ads estimate for a weak $200 budget and is transparent about the duration", async () => {
    await openChat();
    await answer(ADS_WEAK_ANSWERS);

    const body = estimateBubbles()[0]!.querySelector("p")?.textContent ?? "";
    expect(body).toBe([
      "ميزانيتك: $200 شهرياً 🟡",
      "",
      "💡 صريحين معك:",
      "$200 تكفي لـ 16 يوم إعلان فعّال.",
      "",
      "📊 النتائج المتوقعة:",
      "• الظهور: ~8,000-15,000",
      "• الزيارات: ~80-150",
      "• المهتمون: ~2-4",
      "",
      "الأرقام تقديرية وليست ضماناً للنتائج.",
      "",
      "كيف تحب يتواصل معك فريق أفق؟",
      "□ 📱 واتساب",
      "□ 📧 إيميل: البريد المسجّل بحسابك",
      "□ 💬 إشعار في الموقع",
    ].join("\n"));
    expect(postCalls()).toHaveLength(0);
    expect(saved).toEqual([greeting]);
  });

  it("shows monthly projections for a good budget, with larger ranges than the $200 plan", async () => {
    await openChat();
    await answer([
      "إعلانات", "متوسط", "متعدد", "عادي (7 أيام)", "500-1500$",
      "🏪 متجر محلي", "150,000 - 500,000", "🇮🇶 العراق كله",
    ]);

    const body = estimateBubbles()[0]!.querySelector("p")?.textContent ?? "";
    expect(body).toContain("ميزانيتك: $1,500 شهرياً 🟢🟢");
    expect(body).toContain("📊 النتائج المتوقعة شهرياً:");
    expect(body).toContain("• الظهور: ~62,000-114,000");
    expect(body).toContain("• الزيارات: ~620-1,140");
    expect(body).toContain("• المهتمون: ~15-29");
    expect(body).toContain("الأرقام تقديرية وليست ضماناً للنتائج.");
    expect(body).not.toContain("تكفي لـ");
    expect(body).not.toContain("السعر التقديري");
  });

  it("shows only the official price for design, with no invented performance stats", async () => {
    await openChat();
    await answer([
      "تصميم", "متوسط", "Instagram", "عادي (7 أيام)", "200-500$",
      "🍽️ مطعم/مقهى", "50,000 - 150,000", "🏙️ بغداد فقط",
    ]);

    const body = estimateBubbles()[0]!.querySelector("p")?.textContent ?? "";
    expect(body).toBe([
      "السعر التقديري: $500-$1,200",
      "",
      "كيف تحب يتواصل معك فريق أفق؟",
      "□ 📱 واتساب",
      "□ 📧 إيميل: البريد المسجّل بحسابك",
      "□ 💬 إشعار في الموقع",
    ].join("\n"));
    expect(body).not.toMatch(/الظهور|الزيارات|المهتمون|Impressions|Visits|Leads/i);
  });

  it("does not invent a price for the unlisted Other service", () => {
    const body = serviceRequestEstimate({ type: "other", targeting: "iraq_all" }, "ar");
    expect(body).toContain("ما عندنا نطاق سعر معتمد لهذا النوع");
    expect(body).not.toMatch(/\$\d/);
    expect(body).toContain("كيف تحب يتواصل معك فريق أفق؟");
  });

  it("formats the non-ad estimate and contact choices in English", () => {
    const body = serviceRequestEstimate({ type: "seo", size: "small", targeting: "gulf" }, "en");
    expect(body).toContain("Estimated price: $320-$800");
    expect(body).toContain("How would you like the Ofoq team to contact you?");
    expect(body).toContain("□ 📧 Email: the address registered to your account");
    expect(body).not.toContain("Impressions");
  });

  it("never exposes agency fees or a budget split in client messages", () => {
    const ads = serviceRequestEstimate({ type: "ads", budget: "under_200", targeting: "iraq_all" }, "ar");
    const design = serviceRequestEstimate({ type: "design", size: "medium" }, "ar");
    for (const body of [ads, design]) {
      expect(body).not.toMatch(/أتعاب|عمولة|نصيب|توزيع الميزانية|agency fee|ad spend|commission/i);
    }
  });
});
