/**
 * مساعد أفق — the Ofoq assistant.
 *
 * The assistant is the only AI surface a client sees. It runs on the shared
 * `ai-service` chain (Groq → Gemini → NVIDIA → Cohere → OpenRouter, with Cohere
 * promoted for Arabic) and keeps the local deterministic rules engine as a hard
 * fallback: if no provider is configured, or every provider fails, the client
 * still gets an answer that never invents prices, promises or results.
 *
 * Full conversation history (the last MAX_CONTEXT_TURNS client/assistant turns)
 * is forwarded on every call, so switching providers mid-conversation — whether
 * by auto-routing (Arabic → Cohere), rate-limit fallback, or the operator
 * changing priorities — never loses context.
 *
 * The provider id/model are still reported back for diagnostics (`ai_usage`
 * logging and admin views). They are stored in `messages.meta` but are not
 * surfaced to clients in the chat UI.
 */
import type { AiUsageSink } from "@/lib/ai/usage";
import { chat, type AiMessage } from "@/lib/ai/ai-service";
import { detectLanguage } from "@/lib/ai/language";
import { detectEscalation } from "@/lib/agents/escalation-agent";
import { providerLabel } from "@/lib/ai/providers";
import { logger } from "@/lib/core/logger";
import type { Locale } from "@/lib/domain/types";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface ChatCompletion {
  text: string;
  /** Provider id that produced the text: "groq", "cohere", … or "rules". */
  provider: string;
  /** Display name for the badge, in the conversation language. */
  providerName: string;
  model: string;
  /** False when the local rules engine produced the reply. */
  ai: boolean;
}

const MAX_CONTEXT_TURNS = 20;
const MAX_REPLY_TOKENS = 700;
const REPLY_TEMPERATURE = 0.35;

/** The assistant's guardrails: helpful, transparent, and never inventing facts. */
const SYSTEM_INSTRUCTION = [
  "You are مساعد أفق (the Ofoq assistant), a disclosed AI assistant working for the Ofoq digital marketing agency.",
  "Ask only the next necessary discovery question, usually one question at a time. Understand the client's goal, service, market, platforms, scope and timeframe gradually.",
  "Never invent clients, portfolio results, campaign metrics, service availability, exact prices, offers, project creation, payments or external integrations. Do not claim you created or changed records beyond this saved conversation.",
  "Do not expose other customers, internal agency costs, margins, private notes, secrets or payment-card data. Never ask for card details or promise ad spend.",
  "If the request is unusual, unclear, involves refunds, a major discount, legal/safety concerns, or a commitment the system cannot confirm, say that a human team member must review it.",
  "When the client asks about the budget, prices or costs in the general conversation, do not refuse and do not say you cannot confirm or set prices. Instead, gently direct the client to the «اطلب خدمة جديدة» (Request a new service) button, which walks them step by step and calculates the suitable price and expected results. Example reply: \"لعرض الأسعار المناسبة لمشروعك، اضغط على زر «اطلب خدمة جديدة» وامشِ معي خطوة بخطوة، وراح أحسب لك السعر والنتائج المتوقعة.\" Never use phrases such as \"لا يمكنني تأكيد الميزانية\", \"لا يمكنني تحديد الأسعار\", \"يرجى العلم أن فريق Ofoq...\", or their English equivalents. This redirect never replaces a real handoff: if the client explicitly asks for a real person, follow the handoff rule below.",
  "Explain that a human agency team member can take over whenever the client asks. When you hand over, say only that the Ofoq team will follow up: the platform itself records the handoff (an alert for the agency and an email to the owner) and appends the confirmation, so never describe tickets, projects, offers, invoices or payments you did not create. Keep answers concise and practical.",
].join(" ");

function languageInstruction(locale: Locale): string {
  return locale === "ar"
    ? "Reply in clear, friendly Modern Standard Arabic (white Arabic), not a strong regional dialect."
    : "Reply in clear, friendly English.";
}

/** Builds the provider payload: guardrails, then the trimmed conversation. */
export function buildAssistantMessages(
  history: ChatTurn[],
  locale: Locale,
): AiMessage[] {
  const turns = history
    .filter((turn) => (turn.role === "user" || turn.role === "assistant") && turn.content.trim().length > 0)
    .slice(-MAX_CONTEXT_TURNS)
    .map((turn) => ({ role: turn.role, content: turn.content.slice(0, 2_000) }) as AiMessage);

  return [
    { role: "system", content: `${SYSTEM_INSTRUCTION} ${languageInstruction(locale)}` },
    ...turns,
  ];
}

/**
 * Produces the assistant's reply.
 *
 * Always resolves: provider failures degrade to the local rules engine rather
 * than surfacing an error to the client.
 */
export async function completeOfoqChat(input: {
  history: ChatTurn[];
  latestMessage: string;
  locale: Locale;
  customerId?: string | null;
  onUsage?: AiUsageSink;
}): Promise<ChatCompletion> {
  const messages = buildAssistantMessages(input.history, input.locale);

  try {
    const result = await chat(messages, {
      // The client journey belongs to the orchestrator agent, so its usage rows
      // are grouped with the rest of the platform's orchestration work.
      agentKey: "orchestrator",
      customerId: input.customerId ?? null,
      temperature: REPLY_TEMPERATURE,
      maxTokens: MAX_REPLY_TOKENS,
      onUsage: input.onUsage,
    });

    return {
      text: result.text,
      provider: result.provider,
      providerName: providerLabel(result.provider, input.locale),
      model: result.model,
      ai: true,
    };
  } catch (error) {
    logger.warn("Every AI provider failed; the assistant is using its local rules", {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      text: localReply(input.latestMessage, input.locale),
      provider: "rules",
      providerName: providerLabel("rules", input.locale),
      model: "rules-engine",
      ai: false,
    };
  }
}

/**
 * Deterministic fallback replies.
 *
 * These are deliberately restrained: they never quote a price and never promise
 * a result. They may state the *intent* to hand over to a human — the chat route
 * runs the escalation agent right after and appends the verified outcome
 * (`handoffNotice`), so the client is told what actually happened.
 */
export function localReply(message: string, preferredLocale: Locale): string {
  const detected = detectLanguage(message);
  const locale: Locale = detected === "ar" || detected === "en" ? detected : preferredLocale;
  const lower = message.toLowerCase();
  const asksHuman = detectEscalation({ latestMessage: message }).category === "HUMAN_REQUEST";

  if (asksHuman) {
    return locale === "ar"
      ? "أفهم رغبتك بالتحدث مع شخص من فريق أفق، وسأحوّل محادثتك الآن إلى الفريق البشري."
      : "I understand you would like to speak with a person, so I am handing this conversation over to the Ofoq human team now.";
  }

  if (/(price|cost|budget|سعر|تكلفة|ميزانية)/i.test(lower)) {
    return locale === "ar"
      ? "لعرض الأسعار المناسبة لمشروعك، اضغط على زر «اطلب خدمة جديدة» وامشِ معي خطوة بخطوة، وراح أحسب لك السعر والنتائج المتوقعة."
      : "To see the right prices for your project, press the “Request a new service” button and walk through it with me step by step. I will calculate the price and the expected results for you.";
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
