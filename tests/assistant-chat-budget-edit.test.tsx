// @vitest-environment jsdom
/**
 * Changing the budget in the middle of the guided request.
 *
 * «طيب من 200 إلى 500» typed after the budget was answered is a budget update:
 * it is read by the patterns (or, for spoken numbers, by the AI intent route),
 * stored as the normalised `200-500`, the summary and the pricing are
 * recalculated, and the open question stays open. It is never answered with a
 * clarification, never sent to the assistant, and never read as a rejection.
 *
 * The same file covers what the client sees when the save fails: a plain
 * error with a retry that reuses the same request id.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AssistantChat,
  SERVICE_REQUEST_WELCOME,
  budgetUpdatedMessage,
  serviceRequestEstimate,
  serviceRequestSummary,
} from "../src/components/assistant-chat";
import { plainText, plainTexts } from "./helpers/bidi";

const STORAGE_KEY = "ofoq:chat:service-request";
const WELCOME_AR = SERVICE_REQUEST_WELCOME.ar;
const CLIENT_EMAIL = "client@example.com";
const REPLY = "أكيد، أي سؤال ثاني؟";
const ORDER_CODE = "OFOQ-2026-009";

const QUESTION_AR = {
  SIZE: "شكد حجم المشروع؟",
  BUDGET: "شنو الميزانية التقريبية؟",
  TARGETING: "وين تريد تستهدف إعلانك؟",
  CONTACT: "كيف تحب يتواصل معك فريق أفق؟",
};

const FIRST_ANSWERS = { type: "ads", size: "medium", budget: "under_200", targeting: "iraq_all" };
const REVISED_ANSWERS = { ...FIRST_ANSWERS, budget: "200_500", budgetRange: "200-500", budgetAmount: "500" };

interface SavedMessage { id: string; sender: string; body: string; language: string; createdAt: string }

const greeting: SavedMessage = { id: "m-greeting", sender: "ASSISTANT", body: "أهلًا بك في أفق.", language: "ar", createdAt: "2026-10-12T05:00:00.000Z" };
let saved: SavedMessage[] = [];
/** What /api/chat/budget-intent answers (the AI layer) in this test. */
let aiBudget: { range: string; amount: number } | null = null;
/** How /api/chat/service-request answers; each test sets what it needs. */
let serviceRequestResponse: () => Response = () => Response.json({ data: { orderCode: ORDER_CODE, alertId: "alert-1" } });

function stubChatApi(): void {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(String(url), "http://localhost").pathname;
    if (path === "/api/chat/service-intent") return Response.json({ data: { optionId: null, source: "none" } });
    if (path === "/api/chat/budget-intent") {
      return Response.json({ data: { budget: aiBudget ? { ...aiBudget, min: Number(aiBudget.range.split("-")[0]), max: aiBudget.amount } : null, source: aiBudget ? "ai" : "none", provider: "groq" } });
    }
    if (path === "/api/chat/service-request") return serviceRequestResponse();
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

function estimates(): string[] {
  return Array.from(document.querySelectorAll(".chat-messages .chat-message-estimate p")).map((node) => node.textContent ?? "");
}

function storedContext(): Record<string, any> | null {
  return JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? "null");
}

/** POSTs to exactly `path`. */
function postCalls(path: string) {
  return vi.mocked(fetch).mock.calls.filter(([url, init]) => init?.method === "POST" && new URL(String(url), "http://localhost").pathname === path);
}

async function openChat(): Promise<void> {
  render(<AssistantChat locale="ar" intent="service_request" />);
  await waitFor(() => expect(shownBodies()).toContain(WELCOME_AR));
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

/** TYPE, SIZE and BUDGET answered with buttons; the targeting question is open. */
async function answerUpToTargeting(): Promise<void> {
  await chooseAndWait("إعلانات", QUESTION_AR.SIZE);
  await chooseAndWait("متوسط", QUESTION_AR.BUDGET);
  await chooseAndWait("أقل من 200$", QUESTION_AR.TARGETING);
}

beforeEach(() => {
  saved = [greeting];
  aiBudget = null;
  serviceRequestResponse = () => Response.json({ data: { orderCode: ORDER_CODE, alertId: "alert-1" } });
  window.sessionStorage.clear();
  window.history.replaceState({}, "", "/portal/chat?intent=service_request");
  Element.prototype.scrollIntoView = vi.fn();
  stubChatApi();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("budget typed as the answer", () => {
  it("reads «من 200 إلى 500» at the budget question and stores 200-500", async () => {
    await openChat();
    await chooseAndWait("إعلانات", QUESTION_AR.SIZE);
    await chooseAndWait("متوسط", QUESTION_AR.BUDGET);

    type("من 200 إلى 500");
    await waitFor(() => expect(shownBodies().some((body) => body.includes(QUESTION_AR.TARGETING))).toBe(true));

    expect(storedContext()).toMatchObject({ step: "TARGETING", answers: { budget: "200_500", budgetRange: "200-500", budgetAmount: "500" } });
    expect(JSON.stringify(storedContext()?.answers)).not.toContain("500 من 200");
    // The client's own words stay in the thread; nothing went to the assistant.
    expect(shownBodies()).toContain("من 200 إلى 500");
    expect(postCalls("/api/chat")).toHaveLength(0);
    expect(postCalls("/api/chat/budget-intent")).toHaveLength(0);
  });

  it("reads a bare «300» at the budget question, but asks again for a phone-looking number", async () => {
    await openChat();
    await chooseAndWait("إعلانات", QUESTION_AR.SIZE);
    await chooseAndWait("متوسط", QUESTION_AR.BUDGET);

    type("07707048629");
    await waitFor(() => expect(shownBodies().at(-1)).toContain("ما قدرت أحدد الخيار"));
    expect(storedContext()).toMatchObject({ step: "BUDGET" });
    expect(postCalls("/api/chat")).toHaveLength(0);

    type("300");
    await waitFor(() => expect(shownBodies().some((body) => body.includes(QUESTION_AR.TARGETING))).toBe(true));
    expect(storedContext()).toMatchObject({ step: "TARGETING", answers: { budget: "200_500", budgetRange: "300", budgetAmount: "300" } });
  });
});

describe("budget changed mid-conversation", () => {
  it("«طيب من 200 إلى 500» while targeting is open updates the budget and re-asks targeting", async () => {
    await openChat();
    await answerUpToTargeting();

    type("طيب من 200 إلى 500");
    await waitFor(() => expect(plainTexts(shownBodies()).some((body) => body.includes("حدّثت الميزانية إلى 200-500$"))).toBe(true));

    const bodies = plainTexts(shownBodies());
    const update = bodies.find((body) => body.includes("حدّثت الميزانية"))!;
    expect(update).toContain(plainText(budgetUpdatedMessage(REVISED_ANSWERS, "ar")));
    // The open question is asked again; no clarification, no assistant turn.
    expect(update).toContain(QUESTION_AR.TARGETING);
    expect(bodies.some((body) => body.includes("ما قدرت أحدد الخيار"))).toBe(false);
    expect(bodies).not.toContain(REPLY);
    expect(postCalls("/api/chat")).toHaveLength(0);

    const context = storedContext()!;
    expect(context).toMatchObject({ step: "TARGETING", answers: { budget: "200_500", budgetRange: "200-500", budgetAmount: "500" } });
    expect(context.answerLog.at(-1)).toMatchObject({ step: "BUDGET", revision: true, text: "طيب من 200 إلى 500", budget: { range: "200-500", amount: 500 } });

    // Targeting then closes the questions with the revised summary and pricing.
    await chooseAndWait("🇮🇶 العراق كله", "تمام، فهمت طلبك");
    expect(plainTexts(shownBodies())).toContain(plainText(serviceRequestSummary(REVISED_ANSWERS, "ar")));
    expect(estimates()).toEqual([serviceRequestEstimate(REVISED_ANSWERS, "ar", { email: CLIENT_EMAIL })]);
    expect(plainText(estimates()[0]!)).toContain("ميزانيتك: 200-500$");
    expect(plainText(estimates()[0]!)).toContain("التقدير محسوب على 500$");
  });

  it("after the summary, the revised summary and a new estimate are shown and the first ones are kept", async () => {
    await openChat();
    await answerUpToTargeting();
    await chooseAndWait("🇮🇶 العراق كله", "تمام، فهمت طلبك");
    const firstEstimate = serviceRequestEstimate(FIRST_ANSWERS, "ar", { email: CLIENT_EMAIL });
    expect(estimates()).toEqual([firstEstimate]);

    type("طيب من 200 إلى 500");
    await waitFor(() => expect(estimates()).toHaveLength(2));

    const revisedSummary = serviceRequestSummary(REVISED_ANSWERS, "ar", { revised: true });
    expect(plainText(revisedSummary)).toContain("حدّثت الميزانية إلى 200-500$");
    expect(plainTexts(shownBodies())).toContain(plainText(revisedSummary));
    // History is not rewritten: the first summary and estimate stay as they were.
    expect(plainTexts(shownBodies())).toContain(plainText(serviceRequestSummary(FIRST_ANSWERS, "ar")));
    expect(estimates()).toEqual([firstEstimate, serviceRequestEstimate(REVISED_ANSWERS, "ar", { email: CLIENT_EMAIL })]);
    expect(plainText(estimates()[1]!)).toContain("ميزانيتك: 200-500$");
    expect(estimates()[1]).not.toBe(firstEstimate);
    // The contact question is still the open one, with its options.
    expect(storedContext()).toMatchObject({ step: "SUMMARY", answers: { budget: "200_500", budgetRange: "200-500", budgetAmount: "500" } });
    expect(screen.getByRole("button", { name: `📧 إيميل: ${CLIENT_EMAIL}` })).toBeTruthy();

    // The completed request is sent with the revised budget.
    await chooseAndWait(`📧 إيميل: ${CLIENT_EMAIL}`, "تم حفظ طلبك ✅");
    await waitFor(() => expect(storedContext()?.submission).toMatchObject({ status: "saved", orderCode: ORDER_CODE }));
    const [, init] = postCalls("/api/chat/service-request")[0]!;
    const body = JSON.parse(String(init?.body)) as { requestId: string; answers: Record<string, string> };
    expect(body.answers).toMatchObject({ budget: "200_500", budgetRange: "200-500", budgetAmount: "500", contact: "email" });
    expect(body.requestId).toBeTruthy();
    await waitFor(() => expect(shownBodies().some((shown) => shown.includes(`رقم الطلب: ${ORDER_CODE}`))).toBe(true));
  });

  it("falls back to the AI intent for spoken numbers and applies its normalised range", async () => {
    aiBudget = { range: "200-500", amount: 500 };
    await openChat();
    await answerUpToTargeting();

    type("خلي الميزانية بين المئتين والخمسمية دولار");
    await waitFor(() => expect(plainTexts(shownBodies()).some((body) => body.includes("حدّثت الميزانية إلى 200-500$"))).toBe(true));

    const [url, init] = postCalls("/api/chat/budget-intent")[0]!;
    expect(String(url)).toContain("/api/chat/budget-intent");
    expect(JSON.parse(String(init?.body))).toEqual({ message: "خلي الميزانية بين المئتين والخمسمية دولار", bareNumbers: false });
    expect(postCalls("/api/chat")).toHaveLength(0);
    expect(storedContext()).toMatchObject({ step: "TARGETING", answers: { budget: "200_500", budgetRange: "200-500", budgetAmount: "500" } });
  });

  it("a budget-looking message the AI cannot read re-shows the budget options, never a random reply", async () => {
    aiBudget = null;
    await openChat();
    await answerUpToTargeting();

    type("ميزانية على كيفكم تقريباً");
    await waitFor(() => expect(postCalls("/api/chat/budget-intent")).toHaveLength(1));
    await waitFor(() => expect(shownBodies().at(-1)).toContain("ما قدرت أحدد الخيار"));
    // The budget options are offered again, the message is NEVER handed to the
    // assistant (whose only possible answer would be a «cannot confirm the
    // budget» refusal), the step did not change and nothing was guessed.
    expect(shownBodies().at(-1)).toContain("200-500$");
    expect(postCalls("/api/chat")).toHaveLength(0);
    expect(storedContext()).toMatchObject({ step: "TARGETING", answers: { budget: "under_200" } });
    expect(storedContext()?.answers.budgetRange).toBeUndefined();
  });

  it("does not treat a plain targeting answer as a budget", async () => {
    await openChat();
    await answerUpToTargeting();
    type("بغداد فقط");
    await waitFor(() => expect(storedContext()?.step).toBe("SUMMARY"));
    expect(storedContext()).toMatchObject({ answers: { targeting: "baghdad", budget: "under_200" } });
    expect(postCalls("/api/chat/budget-intent")).toHaveLength(0);
  });
});

describe("when the save fails", () => {
  it("tells the client plainly, offers a retry with the same request id, and confirms once saved", async () => {
    let attempts = 0;
    serviceRequestResponse = () => {
      attempts += 1;
      return attempts === 1
        ? Response.json({ error: "The request could not be saved: the service-request database function is not installed yet.", code: "SERVICE_REQUEST_RPC_NOT_INSTALLED" }, { status: 502 })
        : Response.json({ data: { orderCode: ORDER_CODE, alertId: "alert-1" } });
    };
    await openChat();
    await answerUpToTargeting();
    await chooseAndWait("🇮🇶 العراق كله", "تمام، فهمت طلبك");
    choose(`📧 إيميل: ${CLIENT_EMAIL}`);

    await waitFor(() => expect(storedContext()?.submission).toMatchObject({ status: "failed" }));
    const failed = shownBodies().at(-1)!;
    expect(failed).toContain("تعذر حفظ طلبك ❌");
    expect(failed).toContain("0008_service_requests.sql");
    expect(failed).not.toContain("تم حفظ طلبك ✅");
    expect(failed).not.toContain("رقم الطلب:");

    const firstRequestId = JSON.parse(String(postCalls("/api/chat/service-request")[0]![1]?.body)).requestId as string;
    fireEvent.click(screen.getByRole("button", { name: "إعادة المحاولة" }));
    await waitFor(() => expect(storedContext()?.submission).toMatchObject({ status: "saved", orderCode: ORDER_CODE }));

    const secondRequestId = JSON.parse(String(postCalls("/api/chat/service-request")[1]![1]?.body)).requestId as string;
    expect(secondRequestId).toBe(firstRequestId);
    const confirmed = shownBodies().at(-1)!;
    expect(confirmed).toContain("تم حفظ طلبك ✅");
    expect(confirmed).toContain(`رقم الطلب: ${ORDER_CODE}`);
    expect(screen.queryByRole("button", { name: "إعادة المحاولة" })).toBeNull();
  });

  it("resumes a save that was interrupted by a refresh, with the same request id", async () => {
    await openChat();
    await answerUpToTargeting();
    await chooseAndWait("🇮🇶 العراق كله", "تمام، فهمت طلبك");
    await chooseAndWait(`📧 إيميل: ${CLIENT_EMAIL}`, "تم حفظ طلبك ✅");
    await waitFor(() => expect(storedContext()?.submission?.status).toBe("saved"));
    const requestId = storedContext()!.submission.requestId as string;

    // Pretend the page closed before the answer came back.
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ ...storedContext(), submission: { requestId, status: "pending", orderCode: null, alertId: null, error: null } }));
    cleanup();
    vi.mocked(fetch).mockClear();

    await openChat();
    await waitFor(() => expect(storedContext()?.submission).toMatchObject({ status: "saved", orderCode: ORDER_CODE, requestId }));
    expect(JSON.parse(String(postCalls("/api/chat/service-request")[0]![1]?.body)).requestId).toBe(requestId);
    await waitFor(() => expect(shownBodies().some((shown) => shown.includes(`رقم الطلب: ${ORDER_CODE}`))).toBe(true));
  });
});
