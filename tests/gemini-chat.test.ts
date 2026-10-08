import { afterEach, describe, expect, it, vi } from "vitest";

import { completeOfoqChat } from "@/lib/ai/gemini-chat";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("Ofoq chat provider fallback", () => {
  it("uses a restrained local reply when Gemini is not configured", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    const result = await completeOfoqChat({
      history: [{ role: "user", content: "كم سعر إدارة إنستغرام؟" }],
      latestMessage: "كم سعر إدارة إنستغرام؟",
      locale: "ar",
    });
    expect(result.provider).toBe("rules");
    expect(result.text).toContain("السعر");
    expect(result.text).not.toMatch(/\bUSD\b|\$\d/);
  });

  it("responds in English when the message is English", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    const result = await completeOfoqChat({
      history: [{ role: "user", content: "I need a website" }],
      latestMessage: "I need a website",
      locale: "ar",
    });
    expect(result.provider).toBe("rules");
    expect(result.text).toContain("website");
  });

  it("calls Gemini server-side only when a key is present", async () => {
    vi.stubEnv("GEMINI_API_KEY", "unit-test-key");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: "Tell me about your main goal." }] } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await completeOfoqChat({
      history: [{ role: "user", content: "I need a marketing plan" }],
      latestMessage: "I need a marketing plan",
      locale: "en",
    });

    expect(result).toEqual({ text: "Tell me about your main goal.", provider: "gemini" });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toContain("generativelanguage.googleapis.com");
    expect(String(fetchMock.mock.calls[0][0])).toContain("unit-test-key");
  });
});
