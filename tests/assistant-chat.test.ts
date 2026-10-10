import { afterEach, describe, expect, it, vi } from "vitest";

import { buildAssistantMessages, completeOfoqChat } from "@/lib/ai/assistant-chat";
import { callBody, callUrl, clearProviderKeys, completionResponse, errorResponse } from "./ai/completion-mock";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Ofoq assistant provider chain", () => {
  it("uses a restrained local reply when no provider is configured", async () => {
    clearProviderKeys();
    const result = await completeOfoqChat({
      history: [{ role: "user", content: "كم سعر إدارة إنستغرام؟" }],
      latestMessage: "كم سعر إدارة إنستغرام؟",
      locale: "ar",
    });
    expect(result.provider).toBe("rules");
    expect(result.ai).toBe(false);
    expect(result.providerName).toBe("القواعد المحلية");
    expect(result.text).toContain("السعر");
    expect(result.text).not.toMatch(/\bUSD\b|\$\d/);
  });

  it("responds in English when the message is English and no provider is configured", async () => {
    clearProviderKeys();
    const result = await completeOfoqChat({
      history: [{ role: "user", content: "I need a website" }],
      latestMessage: "I need a website",
      locale: "ar",
    });
    expect(result.provider).toBe("rules");
    expect(result.text).toContain("website");
  });

  it("calls the first configured provider server-side and reports the badge name", async () => {
    clearProviderKeys();
    vi.stubEnv("GROQ_API_KEY", "unit-test-key");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(completionResponse("Tell me about your main goal.", { model: "llama-3.3-70b-versatile" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await completeOfoqChat({
      history: [{ role: "user", content: "I need a marketing plan" }],
      latestMessage: "I need a marketing plan",
      locale: "en",
    });

    expect(result).toEqual({
      text: "Tell me about your main goal.",
      provider: "groq",
      providerName: "Groq",
      model: "llama-3.3-70b-versatile",
      ai: true,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(callUrl(fetchMock, 0)).toContain("https://api.groq.com/openai/v1/chat/completions");

    const body = callBody(fetchMock, 0);
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content).toContain("مساعد أفق");
    expect(messages.at(-1)).toEqual({ role: "user", content: "I need a marketing plan" });
    // The key travels in the Authorization header, never in the URL.
    expect(callUrl(fetchMock, 0)).not.toContain("unit-test-key");
  });

  it("degrades to the local rules engine when every provider fails", async () => {
    clearProviderKeys();
    vi.stubEnv("GROQ_API_KEY", "unit-test-key");
    vi.stubEnv("GEMINI_API_KEY", "unit-test-key");
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(500, "boom"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await completeOfoqChat({
      history: [{ role: "user", content: "كم سعر الباقة الشهرية؟" }],
      latestMessage: "كم سعر الباقة الشهرية؟",
      locale: "ar",
    });

    expect(result.provider).toBe("rules");
    expect(result.ai).toBe(false);
    expect(result.text).toContain("السعر");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the guardrails and trims the conversation context", () => {
    const history = Array.from({ length: 40 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `turn ${index}`,
    }));

    const messages = buildAssistantMessages(history, "ar");

    // One system message plus at most 20 turns of context.
    expect(messages).toHaveLength(21);
    expect(messages[0]?.content).toContain("Never invent clients");
    expect(messages[0]?.content).toContain("Modern Standard Arabic");
    expect(messages.at(-1)?.content).toBe("turn 39");
  });
});
