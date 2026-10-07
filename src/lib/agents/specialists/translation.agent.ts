import { aiComplete, aiAvailable } from "@/lib/ai/provider";
import { detectLanguage, isArabic, resolveLocale } from "@/lib/ai/language";
import type { Locale } from "@/lib/domain/types";

import { runAgent } from "../runtime";

/**
 * Translation agent.
 *
 * Translates client-visible text between Arabic and English. Rules:
 *  · numbers, dates, prices, codes and proper nouns are never altered,
 *  · Arabic output is clear Modern Standard Arabic ("white Arabic") — simple,
 *    friendly, no strong dialect,
 *  · without an AI provider the agent does not pretend to translate: it returns
 *    the original text and says the provider is unavailable, so staff can
 *    translate manually instead of shipping a broken message.
 */
export interface TranslationResult {
  translated: string;
  sourceLanguage: Locale | "unknown";
  targetLanguage: Locale;
  usedAi: boolean;
  note?: string;
}

export async function translateText(input: {
  text: string;
  target: Locale;
  locale: Locale;
  context?: string;
  conversationId?: string | null;
  customerId?: string | null;
}): Promise<TranslationResult> {
  const source = detectLanguage(input.text);

  if (source === input.target) {
    return {
      translated: input.text,
      sourceLanguage: source,
      targetLanguage: input.target,
      usedAi: false,
      note: "already_in_target_language",
    };
  }

  if (!aiAvailable()) {
    return {
      translated: input.text,
      sourceLanguage: source,
      targetLanguage: input.target,
      usedAi: false,
      note:
        input.locale === "ar"
          ? "الترجمة الآلية تحتاج ربط مزود ذكاء اصطناعي. لم يتم تغيير النص الأصلي."
          : "Automatic translation needs an AI provider. The original text was kept unchanged.",
    };
  }

  try {
    const result = await aiComplete({
      messages: [
        {
          role: "system",
          content:
            `Translate the user's text into ${input.target === "ar" ? "clear Modern Standard Arabic (simple, friendly, no regional dialect)" : "clear professional English"}. ` +
            "Keep every number, price, date, code, name and policy statement exactly as written. " +
            "Do not add information, promises or opinions. Reply with the translation only.",
        },
        {
          role: "user",
          content: input.context ? `Context: ${input.context}\n\nText:\n${input.text}` : input.text,
        },
      ],
      temperature: 0.2,
    });

    const outcome = await runAgent(
      "translator",
      {
        trigger: "translation.requested",
        locale: input.locale,
        customerId: input.customerId ?? null,
        conversationId: input.conversationId ?? null,
        input: { target: input.target, source, length: input.text.length },
      },
      async ({ record }) => {
        record({
          action: "text.translated",
          summary: `ترجمة نص من ${source} إلى ${input.target}`,
          entityType: "customer",
          entityId: input.customerId ?? null,
          riskLevel: "LOW",
        });
        return {
          data: { length: result.text.length },
          summary: `ترجمة (${source} → ${input.target})`,
          riskLevel: "LOW",
        };
      },
    );
    void outcome;

    return {
      translated: result.text,
      sourceLanguage: source,
      targetLanguage: input.target,
      usedAi: true,
    };
  } catch {
    return {
      translated: input.text,
      sourceLanguage: source,
      targetLanguage: input.target,
      usedAi: false,
      note:
        input.locale === "ar"
          ? "تعذّر الاتصال بمزود الترجمة، فبقي النص الأصلي."
          : "The translation provider was unreachable, so the original text was kept.",
    };
  }
}

/**
 * Translates a message *for staff eyes only*: the client-facing record keeps the
 * original text, and the translation is stored beside it (`translated_body`), so
 * nothing can be mis-quoted back to the client.
 */
export async function translateMessageForStaff(input: {
  text: string;
  staffLocale: Locale;
  customerId?: string | null;
  conversationId?: string | null;
}): Promise<TranslationResult> {
  return translateText({
    text: input.text,
    target: input.staffLocale,
    locale: input.staffLocale,
    context: "Internal: message received from a client in another language.",
    customerId: input.customerId ?? null,
    conversationId: input.conversationId ?? null,
  });
}

/** Reports the language of an inbound message so routing can prefer the right queue. */
export function describeLanguage(text: string): { language: Locale | "unknown"; isArabicScript: boolean } {
  return { language: detectLanguage(text), isArabicScript: isArabic(text) };
}

/** Picks the language the reply should be written in. */
export function replyLanguage(inboundText: string, customerLocale: Locale, staffLocale?: Locale): Locale {
  return resolveLocale(inboundText, staffLocale ?? customerLocale);
}
