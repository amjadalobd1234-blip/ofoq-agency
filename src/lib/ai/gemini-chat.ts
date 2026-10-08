import { getEnv } from "@/lib/config/env";
import type { Locale } from "@/lib/domain/types";
import { detectLanguage } from "@/lib/ai/language";
import { logger } from "@/lib/core/logger";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface ChatCompletion {
  text: string;
  provider: "gemini" | "rules";
}

const MAX_CONTEXT_TURNS = 20;

/** Uses Gemini over HTTPS when configured; otherwise stays useful without inventing data. */
export async function completeOfoqChat(input: {
  history: ChatTurn[];
  latestMessage: string;
  locale: Locale;
}): Promise<ChatCompletion> {
  const env = getEnv();
  if (env.gemini.enabled) {
    try {
      const text = await callGemini(input.history, input.locale, env.gemini.apiKey, env.gemini.model, env.ai.timeoutMs);
      if (text) return { text, provider: "gemini" };
    } catch (error) {
      logger.warn("Gemini chat unavailable; using the local assistant fallback", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { text: localReply(input.latestMessage, input.locale), provider: "rules" };
}

async function callGemini(
  history: ChatTurn[],
  locale: Locale,
  apiKey: string,
  modelName: string,
  timeoutMs: number,
): Promise<string | null> {
  const model = /^[A-Za-z0-9._-]+$/.test(modelName) ? modelName : "gemini-2.0-flash";
  const url = new URL(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`);
  url.searchParams.set("key", apiKey);

  const languageInstruction = locale === "ar"
    ? "Reply in clear, friendly Modern Standard Arabic (white Arabic), not a strong regional dialect."
    : "Reply in clear, friendly English.";
  const systemInstruction = [
    "You are مساعد أفق (the Ofoq assistant), a disclosed AI assistant working for the Ofoq digital marketing agency.",
    languageInstruction,
    "Ask only the next necessary discovery question, usually one question at a time. Understand the client's goal, service, market, platforms, scope and timeframe gradually.",
    "Never invent clients, portfolio results, campaign metrics, service availability, exact prices, offers, project creation, payments or external integrations. Do not claim you created or changed records beyond this saved conversation.",
    "Do not expose other customers, internal agency costs, margins, private notes, secrets or payment-card data. Never ask for card details or promise ad spend.",
    "If the request is unusual, unclear, involves refunds, a major discount, a large budget, legal/safety concerns, or a commitment the system cannot confirm, say that a human team member must review it. Do not claim that a notification was sent.",
    "Explain that a human agency team member can take over whenever the client asks. Keep answers concise and practical.",
  ].join(" ");

  const contents = history.slice(-MAX_CONTEXT_TURNS).map((turn) => ({
    role: turn.role === "assistant" ? "model" : "user",
    parts: [{ text: turn.content.slice(0, 2000) }],
  }));
  if (!contents.length || contents.at(-1)?.role !== "user") return null;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemInstruction }] },
      contents,
      generationConfig: { temperature: 0.35, maxOutputTokens: 700 },
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(Math.min(Math.max(timeoutMs, 1_000), 30_000)),
  });
  if (!response.ok) {
    // Avoid logging the request URL because the API key is carried as a query parameter.
    throw new Error(`Gemini returned HTTP ${response.status}`);
  }
  const payload = await response.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  return payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim() || null;
}

function localReply(message: string, preferredLocale: Locale): string {
  const detected = detectLanguage(message);
  const locale: Locale = detected === "ar" || detected === "en" ? detected : preferredLocale;
  const lower = message.toLowerCase();
  const asksHuman = /(human|person|team member|موظف|فريق بشري|شخص حقيقي)/i.test(lower);

  if (asksHuman) {
    return locale === "ar"
      ? "أفهم رغبتك بالتحدث مع شخص من الفريق. هذه النسخة تحفظ المحادثة لكنها لا ترسل تنبيهًا مباشرًا للفريق، لذلك لا أستطيع أن أعدك بمتابعة فورية."
      : "I understand you would like to speak with a person. This version saves the conversation but does not send a live team alert, so I cannot promise an immediate follow-up.";
  }

  if (/(price|cost|budget|سعر|تكلفة|ميزانية)/i.test(lower)) {
    return locale === "ar"
      ? "السعر يتحدد بعد فهم نطاق العمل، ولا أريد أن أعطيك رقمًا غير دقيق. ما الخدمة التي تحتاجها، وما حجم العمل أو عدد المنصات المطلوبة؟"
      : "The price depends on the agreed scope, so I do not want to guess a number. Which service do you need, and what scale or number of platforms should it cover?";
  }

  if (/(website|web site|موقع|متجر)/i.test(lower)) {
    return locale === "ar"
      ? "أستطيع مساعدتك في توضيح احتياج الموقع. هل تحتاج موقعًا تعريفيًا أم متجرًا إلكترونيًا، وما الهدف الأساسي منه؟"
      : "I can help clarify the website scope. Do you need a company website or an online store, and what is its main goal?";
  }

  if (/(ads|advert|إعلان|اعلان|حملة)/i.test(lower)) {
    return locale === "ar"
      ? "يمكننا مناقشة خطة إعلانية، لكن لا يوجد حساب إعلاني مرتبط بهذه المنصة الآن. ما المنصة التي تريد الإعلان عليها، وما الهدف من الحملة؟"
      : "We can discuss an advertising plan, but no ad account is connected to this platform yet. Which platform and campaign goal do you have in mind?";
  }

  return locale === "ar"
    ? "شكرًا لك، وصلتني فكرتك. لنبدأ بالهدف الأهم: ما النتيجة التي تريد أن يحققها التسويق لنشاطك؟"
    : "Thanks, I have your message. Let us start with the main goal: what result do you want marketing to achieve for your business?";
}
