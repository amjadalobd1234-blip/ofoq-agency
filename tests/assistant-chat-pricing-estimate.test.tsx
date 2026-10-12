// @vitest-environment jsdom
/**
 * التقدير المبدئي في المحادثة — the closing message of a guided «طلب خدمة»:
 * the price estimation the pricing agent computes from the client's answers.
 *
 * What this file pins down, in the client's own words:
 *   * an ad request shows planning ranges (impressions → visits → leads),
 *   * a design/social/content/SEO request shows a qualitative outcome instead —
 *     never invented performance numbers,
 *   * a weak budget adds the launch suggestions and still accepts the request,
 *   * the agency fee and the ad-spend split are never written anywhere in the
 *     conversation, whatever the answers are.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AssistantChat } from "../src/components/assistant-chat";

const STORAGE_KEY = "ofoq:chat:service-request";

interface SavedMessage { id: string; sender: string; body: string; language: string; createdAt: string }

const greeting: SavedMessage = { id: "m-greeting", sender: "ASSISTANT", body: "أهلًا بك في أفق. أنا مساعد أفق، مساعد ذكي تابع للوكالة.", language: "ar", createdAt: "2026-10-12T05:00:00.000Z" };
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

function shownBodies(): string[] {
  return Array.from(document.querySelectorAll(".chat-messages .chat-message p")).map((node) => node.textContent ?? "");
}

/** The estimate message, as its own bubble. */
function estimateBubbles(): Element[] {
  return Array.from(document.querySelectorAll(".chat-messages .chat-message-estimate"));
}

function postCalls() {
  return vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST");
}

async function openChat(locale: "ar" | "en" = "ar"): Promise<void> {
  render(<AssistantChat locale={locale} intent="service_request" />);
  await waitFor(() => expect(document.querySelectorAll(".chat-messages .chat-message").length).toBeGreaterThan(0));
}

function choose(label: string): void {
  fireEvent.click(screen.getByRole("button", { name: label }));
}

async function answer(choices: string[]): Promise<void> {
  for (const label of choices) {
    choose(label);
    await waitFor(() => expect(shownBodies().length).toBeGreaterThan(1));
  }
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

describe("price estimation after the guided request", () => {
  it("shows an ads request with planning ranges and, on a weak budget, the launch suggestions — and never the internal split", async () => {
    await openChat();
    // إعلانات · صغير · متعدد · عادي · أقل من 200$ → founding: 200×0.84 … 800×0.84
    await answer(["إعلانات", "صغير", "متعدد", "عادي (7 أيام)", "أقل من 200$"]);

    const expected = [
      "حسبت لك تقدير مبدئي على أساس إجاباتك:",
      "",
      "💰 السعر التقديري: 168$ – 672$",
      "🎯 الأنسب لمشروعك: 420$",
      "📊 تقييم الميزانية: 🟡 ضعيفة",
      "",
      "📈 النتائج المتوقعة شهرياً (تقدير):",
      "• الظهور: 46,700 – 86,700",
      "• الزيارات: 930 – 1,730",
      "• العملاء المحتملون: 28 – 52",
      "",
      "💡 نبدأ بهاي الطريقة لتناسب ميزانيتك:",
      "• نبدأ بمنصة وحدة (Instagram مثلاً) ونوسع لاحقاً",
      "• نخلي التسليم عادي بدل مستعجل",
      "• نبدأ بخدمة أصغر (تصميم شعار فقط مثلاً)",
      "ما نرفض أي طلب: نبدأ بالخطوة الأصغر ونتوسع لاحقاً.",
      "",
      "الأرقام تقديرية للتخطيط، وتُثبَّت في العرض الرسمي قبل أي دفعة.",
      "بنيناها على متوسطات السوق (تكلفة الظهور، نسبة النقر، نسبة التحويل) — مو وعد بنتيجة.",
      "إذا حبيت تكمل مع الفريق اكتب: «أريد التحدث مع شخص من الفريق».",
    ].join("\n");

    await waitFor(() => expect(estimateBubbles()).toHaveLength(1));
    const [bubble] = estimateBubbles();
    expect(bubble.querySelector("p")?.textContent).toBe(expected);
    // It is the last thing the client sees, and it is not a saved conversation message.
    expect(shownBodies().at(-1)).toBe(expected);
    expect(saved).toEqual([greeting]);
    expect(postCalls()).toHaveLength(0);

    // الأتعاب وتوزيع الميزانية: داخلي بالكامل. (midPrice 420 → fee 84، إعلانات 336)
    expect(expected).not.toMatch(/أتعاب|عمولة|توزيع الميزانية|نصيب|agency fee|ad spend|20%|25%/);
    expect(expected).not.toContain("84$");
    expect(expected).not.toContain("336$");
  });

  it("describes the outcome of a non-ad service qualitatively: no impressions, no leads", async () => {
    await openChat();
    // تصميم · متوسط · Instagram · مستعجل · 200-500$ → founding 300×1.25 … 700×1.25
    await answer(["تصميم", "متوسط", "Instagram", "مستعجل (3 أيام)", "200-500$"]);

    const expected = [
      "حسبت لك تقدير مبدئي على أساس إجاباتك:",
      "",
      "💰 السعر التقديري: 375$ – 875$",
      "🎯 الأنسب لمشروعك: 625$",
      "📊 تقييم الميزانية: 🟢 متوسطة",
      "",
      "✨ ما تحصل عليه:",
      "تصاميم بهوية واحدة: شكل ثابت لحسابك يوضّح عرضك من أول نظرة ويزيد ثقة الزائر.",
      "",
      "الأرقام تقديرية للتخطيط، وتُثبَّت في العرض الرسمي قبل أي دفعة.",
      "إذا حبيت تكمل مع الفريق اكتب: «أريد التحدث مع شخص من الفريق».",
    ].join("\n");

    await waitFor(() => expect(estimateBubbles()).toHaveLength(1));
    expect(estimateBubbles()[0].querySelector("p")?.textContent).toBe(expected);
    expect(expected).not.toContain("الظهور");
    expect(expected).not.toContain("العملاء المحتملون");
    // A medium budget needs no suggestions.
    expect(expected).not.toContain("💡");
  });

  it("runs the estimation in English too, with the English labels and suggestions", async () => {
    saved = [{ ...greeting, body: "Welcome to Ofoq.", language: "en" }];
    await openChat("en");
    await answer(["SEO", "Small", "Google", "Standard (7 days)", "Under $200"]);

    await waitFor(() => expect(estimateBubbles()).toHaveLength(1));
    const body = estimateBubbles()[0].querySelector("p")?.textContent ?? "";

    // seo founding: 250×0.7 … 700×0.7 = 175 … 490
    expect(body).toContain("💰 Estimated price: 175$ – 490$");
    expect(body).toContain("🎯 Best fit for your project: 333$");
    expect(body).toContain("📊 Budget read: 🟡 Tight");
    expect(body).toContain("✨ What you get:");
    expect(body).toContain("• We start with one platform (Instagram, for example) and expand later");
    expect(body).not.toContain("Impressions:");
    expect(body).not.toContain("أتعاب");
  });

  it("keeps a request saved before the budget bands changed, and prices it on the band that covers the same range", async () => {
    const answerLog = ["TYPE", "SIZE", "PLATFORMS", "DEADLINE", "BUDGET"].map((step) => ({
      step,
      afterMessageId: "m-greeting",
      answeredAt: "2026-10-12T05:02:00.000Z",
    }));
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
      intent: "service_request",
      conversationId: "conv-1",
      afterMessageId: "m-greeting",
      startedAt: "2026-10-12T05:00:00.000Z",
      step: "SUMMARY",
      answers: { type: "design", size: "medium", platforms: "instagram", deadline: "urgent_3_days", budget: "300_700" },
      answerLog,
    }));

    await openChat();

    await waitFor(() => expect(estimateBubbles()).toHaveLength(1));
    // «300-700$» is now «200-500$»: the same range, the band the agent knows.
    expect(shownBodies()).toContain("200-500$");
    expect(estimateBubbles()[0].querySelector("p")?.textContent).toContain("📊 تقييم الميزانية: 🟢 متوسطة");
    expect(estimateBubbles()[0].querySelector("p")?.textContent).toContain("💰 السعر التقديري: 375$ – 875$");
    expect(postCalls()).toHaveLength(0);
  });
});
