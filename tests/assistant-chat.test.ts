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
      .mockResolvedValue(completionResponse("Tell me about your main goal.", { model: "openai/gpt-oss-120b" }));
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
      model: "openai/gpt-oss-120b",
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
    // Every declared model of the two configured providers is attempted
    // (Groq: 3, Gemini: 3) before the rules engine takes over.
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("passes the complete multi-turn history (not just the latest message) to the provider", async () => {
    clearProviderKeys();
    vi.stubEnv("GROQ_API_KEY", "unit-test-key");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(completionResponse("Tell me about the platforms.", { model: "openai/gpt-oss-120b" }));
    vi.stubGlobal("fetch", fetchMock);

    // The SQL RPC `ofoq_client_chat_send` inserts the new user message first
    // and then returns the whole conversation (last 20 turns) in chronological
    // order, so `history` already ends with the latest user message.
    const history = [
      { role: "user" as const, content: "حملة إعلانية لمواقع السوشيال ميديا" },
      { role: "assistant" as const, content: "شكراً، وضّح فكرتك..." },
      { role: "user" as const, content: "جلب عملاء" },
      { role: "assistant" as const, content: "ما نوع النشاط؟" },
      { role: "user" as const, content: "بيع أدوات تجارة" },
      { role: "assistant" as const, content: "ما المنصات؟" },
      { role: "user" as const, content: "فيسبوك وإنستغرام وتيكتوك" },
    ];

    await completeOfoqChat({
      history,
      latestMessage: "فيسبوك وإنستغرام وتيكتوك",
      locale: "ar",
    });

    const body = callBody(fetchMock, 0);
    const sentMessages = body.messages as Array<{ role: string; content: string }>;

    // System guardrails first.
    expect(sentMessages[0]?.role).toBe("system");
    expect(sentMessages[0]?.content).toContain("مساعد أفق");

    // The entire multi-turn history must reach the provider — including the
    // user's very first message — so switching providers mid-conversation
    // (e.g. Groq → Cohere → Groq) never loses context.
    const conversationMessages = sentMessages.slice(1);
    expect(conversationMessages).toHaveLength(history.length);
    expect(conversationMessages[0]).toEqual({ role: "user", content: "حملة إعلانية لمواقع السوشيال ميديا" });
    expect(conversationMessages[1]).toEqual({ role: "assistant", content: "شكراً، وضّح فكرتك..." });
    expect(conversationMessages.at(-1)).toEqual({ role: "user", content: "فيسبوك وإنستغرام وتيكتوك" });
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
