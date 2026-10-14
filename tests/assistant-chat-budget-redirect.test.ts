import { afterEach, describe, expect, it, vi } from "vitest";

import { buildAssistantMessages, completeOfoqChat } from "@/lib/ai/assistant-chat";
import { detectEscalation } from "@/lib/agents/escalation-agent";

import { callBody, clearProviderKeys } from "./ai/completion-mock";

/**
 * The general assistant must not refuse budget/price questions. It points the
 * client to «اطلب خدمة جديدة», which calculates the price. Explicit requests for
 * a real person still escalate exactly as before.
 */

const REDIRECT_BUTTON = "اطلب خدمة جديدة";

/** Refusal phrasings that must never reach the client for a budget/price question. */
const FORBIDDEN_REFUSALS = [
  "لا يمكنني تأكيد الميزانية",
  "لا يمكنني تحديد الأسعار",
  "يرجى العلم أن فريق Ofoq",
];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function generalReply(message: string) {
  clearProviderKeys();
  return completeOfoqChat({
    history: [{ role: "user", content: message }],
    latestMessage: message,
    locale: "ar",
  });
}

describe("general assistant — budget and price questions", () => {
  it("budget question redirects to service request button", async () => {
    const result = await generalReply("تحديد الميزانية");

    expect(result.ai).toBe(false);
    expect(result.text).toContain(REDIRECT_BUTTON);
    for (const refusal of FORBIDDEN_REFUSALS) {
      expect(result.text).not.toContain(refusal);
    }
  });

  it("price question redirects to service request button", async () => {
    for (const message of ["شكد السعر؟", "اريد اعرف السعر", "اريد اعرف التكلفة"]) {
      const result = await generalReply(message);

      expect(result.text, message).toContain(REDIRECT_BUTTON);
      for (const refusal of FORBIDDEN_REFUSALS) {
        expect(result.text, message).not.toContain(refusal);
      }
    }
  });

  it("the provider prompt tells the model to redirect instead of refusing", () => {
    const [system] = buildAssistantMessages([{ role: "user", content: "تحديد الميزانية" }], "ar");
    const content = system?.content ?? "";

    expect(content).toContain(REDIRECT_BUTTON);
    // The forbidden phrases appear only inside the "never use" clause, not as
    // a reply the model is asked to give.
    expect(content).toContain("Never use phrases such as");
  });
});

describe("general assistant — real human requests still escalate", () => {
  it("human request still triggers escalation", async () => {
    const message = "اريد التحدث مع شخص حقيقي";

    expect(detectEscalation({ latestMessage: message }).category).toBe("HUMAN_REQUEST");

    const result = await generalReply(message);
    expect(result.text).toContain("فريق أفق");
    expect(result.text).not.toContain(REDIRECT_BUTTON);
  });

  it("keeps the human handoff rule in the provider prompt", () => {
    const [system] = buildAssistantMessages([{ role: "user", content: "أريد شخص حقيقي" }], "ar");

    expect(system?.content).toContain("a human agency team member can take over whenever the client asks");
  });

  it("sends the budget redirect to the provider without changing the human handoff", async () => {
    clearProviderKeys();
    vi.stubEnv("GROQ_API_KEY", "unit-test-key");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" } }],
          model: "openai/gpt-oss-120b",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await completeOfoqChat({
      history: [{ role: "user", content: "تحديد الميزانية" }],
      latestMessage: "تحديد الميزانية",
      locale: "ar",
    });

    const body = callBody(fetchMock, 0) as { messages: Array<{ role: string; content: string }> };
    expect(body.messages[0]?.content).toContain(REDIRECT_BUTTON);
  });
});
