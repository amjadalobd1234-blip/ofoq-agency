/**
 * AI intent matching for the guided service request — layer 3 of the hybrid
 * matcher.
 *
 * When the deterministic matcher cannot name a service type (`matchOption`),
 * the client's phrase is sent to the AI provider chain, which starts with Groq
 * (`GROQ_API_KEY` in `.env`). The model is asked for one thing only: the service
 * type the client means, as one of the published option ids (`ads`, `design`,
 * `social_media`, `content`, `seo`, `other`).
 *
 * Whatever comes back is validated against the option list before it is used.
 * An unknown, empty or failed answer resolves to `null`, and the caller shows
 * the clarification message with the available options — no random value is
 * ever saved.
 */
import { chat } from "@/lib/ai/ai-service";
import { logger } from "@/lib/core/logger";

import { matchOption, serviceTypeOptions, type MatchableOption } from "./service-request";

export interface ServiceIntentResolution {
  /** A published option id, or `null` when the intent stayed unknown. */
  optionId: string | null;
  /** Which layer produced the answer: the local matcher, the AI, or nothing. */
  source: "local" | "ai" | "none";
  provider?: string;
  model?: string;
}

const OPTIONS: MatchableOption[] = serviceTypeOptions();

const SYSTEM_PROMPT = [
  "You extract the service type from one client message for the Ofoq agency assistant.",
  "Answer with JSON only, exactly: {\"serviceType\":\"<id>\"}",
  "Allowed ids and their meaning:",
  "  design       → تصميم، شعار، هوية بصرية، منشورات مصممة، بروشور",
  "  ads          → إعلانات مدفوعة، حملة إعلانية، Google/TikTok/Meta Ads، ترافيك",
  "  social_media → إدارة صفحات وحسابات التواصل، نشر ومتابعة يومية",
  "  content      → كتابة محتوى، نصوص، سكربتات، مقالات",
  "  seo          → تحسين محركات البحث، ظهور في نتائج جوجل",
  "  other        → anything that is none of the above",
  "If the message does not indicate any service, answer {\"serviceType\":null}.",
].join("\n");

/**
 * Pulls the service type out of a model answer and keeps it only when it names
 * a real option. Handles a JSON object, a JSON string and a bare word.
 */
export function parseServiceTypeAnswer(answer: string): string | null {
  const raw = (answer ?? "").trim();
  if (!raw) return null;

  const candidates: string[] = [];
  const withoutFence = raw.replace(/```(?:json)?/gi, " ").trim();
  const jsonStart = withoutFence.indexOf("{");
  const jsonEnd = withoutFence.lastIndexOf("}");

  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    try {
      const parsed: unknown = JSON.parse(withoutFence.slice(jsonStart, jsonEnd + 1));
      if (typeof parsed === "string") {
        candidates.push(parsed);
      } else if (parsed && typeof parsed === "object") {
        const record = parsed as Record<string, unknown>;
        for (const key of ["serviceType", "service_type", "optionId", "option", "type", "value", "result", "intent"]) {
          const value = record[key];
          if (typeof value === "string") candidates.push(value);
        }
      }
    } catch {
      // Not JSON after all: fall through to the plain-text candidates.
    }
  }
  candidates.push(withoutFence);

  for (const candidate of candidates) {
    const cleaned = candidate.replace(/[\s"'`،.]+$/g, "").trim();
    if (!cleaned || /^null$/i.test(cleaned)) continue;
    const match = matchOption(cleaned, OPTIONS);
    if (match) return match.value;
  }
  return null;
}

/**
 * Asks the AI provider chain (Groq first) for the service type of a message.
 * Never throws: a provider problem simply means "no intent found".
 */
export async function extractServiceTypeIntent(
  message: string,
): Promise<{ optionId: string | null; provider?: string; model?: string }> {
  const text = message.trim().slice(0, 800);
  if (!text) return { optionId: null };

  try {
    const result = await chat(
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: text },
      ],
      {
        agentKey: "service-intent",
        temperature: 0,
        maxTokens: 60,
        timeoutMs: 10_000,
        json: true,
      },
    );
    return { optionId: parseServiceTypeAnswer(result.text), provider: result.provider, model: result.model };
  } catch (error) {
    logger.warn("Service-intent extraction failed; asking the client to pick an option", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { optionId: null };
  }
}

/**
 * Hybrid resolution used by the chat: exact/partial matching first, AI intent
 * as the fallback. `optionId: null` means the client must be shown the options.
 */
export async function resolveServiceIntent(message: string): Promise<ServiceIntentResolution> {
  const local = matchOption(message, OPTIONS);
  if (local) return { optionId: local.value, source: "local" };

  const ai = await extractServiceTypeIntent(message);
  if (ai.optionId) {
    return { optionId: ai.optionId, source: "ai", provider: ai.provider, model: ai.model };
  }
  return { optionId: null, source: "none", provider: ai.provider, model: ai.model };
}
