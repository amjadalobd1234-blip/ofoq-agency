import { resolveLocale, t } from "@/lib/ai/language";
import { formatMoney } from "@/lib/core/money";
import { logger } from "@/lib/core/logger";
import type { CustomerRow, Locale } from "@/lib/domain/types";
import { upsertCustomerFact } from "@/lib/repositories/customers.repo";

import { runAgent } from "../runtime";
import { buildSummary, extractRequirements, loadProfile, nextQuestion, type RequirementProfile } from "./needs.agent";
import { priceRequirements, type PricingOutcome } from "./pricing.agent";
import { buildProposal } from "./proposal.agent";
import { createDeliveryPlan } from "./delivery.agent";
import { answerSupportQuestion, classifyIntent, loadSupportContext, type SupportAnswer } from "./support.agent";

/**
 * Main orchestrator agent — the agency's client journey owner.
 *
 * The client only ever talks to "مساعد أفق". This agent:
 *   1. understands the request (needs analyst),
 *   2. creates/updates the client file with sourced facts,
 *   3. distributes work to specialist agents (pricing → proposal → delivery),
 *   4. keeps the client informed and follows up until delivery,
 *   5. detects unusual cases and records every decision.
 *
 * The journey is a deterministic state machine persisted in the client file, so
 * the same behaviour is reproducible with or without an AI provider — an AI
 * provider improves wording and free-text understanding, it is never required.
 */
export type JourneyStage = "NEW" | "COLLECTING" | "CONFIRMING" | "QUOTED" | "APPROVED" | "DELIVERING";

export interface AssistantTurnResult {
  reply: string;
  quickReplies: string[];
  stage: JourneyStage;
  language: Locale;
  /** Present when the assistant produced or referenced a concrete record. */
  refs?: {
    offerId?: string;
    offerCode?: string;
    projectId?: string;
    conversationStep?: string;
  };
  /** True when a human should be notified (complaint, odd request, escalation). */
  escalate?: boolean;
  escalationReason?: string;
  /** Internal (never sent to the client) note for the activity log. */
  internalNote?: string;
}

export interface OrchestratorInput {
  customer: CustomerRow;
  message: string;
  conversationId?: string | null;
  /** Staff-imposed override, used by the dashboard "simulate" tool. */
  actorUserId?: string | null;
}

export async function handleClientTurn(input: OrchestratorInput): Promise<AssistantTurnResult> {
  const locale = resolveLocale(input.message, input.customer.locale);
  const profileBefore = await loadProfile(input.customer);
  const factsStage = (await loadStage(input.customer)) ?? "NEW";

  // The turn is executed exactly ONCE inside the agent run, so a retry/logging
  // path can never create a duplicate offer or project.
  const outcome = await runAgent<AssistantTurnResult>(
    "orchestrator",
    {
      trigger: "chat.message",
      locale,
      customerId: input.customer.id,
      conversationId: input.conversationId ?? null,
      input: { stage: factsStage, messageLength: input.message.length },
    },
    async ({ record }) => {
      const result = await routeMessage({ ...input, locale, profileBefore, stage: factsStage });

      record({
        action: `journey.${result.stage.toLowerCase()}`,
        summary: `رحلة العميل: ${factsStage} → ${result.stage}`,
        reason: result.internalNote,
        entityType: "customer",
        entityId: input.customer.id,
        riskLevel: result.escalate ? "HIGH" : "LOW",
        requiresApproval: result.escalate ?? false,
        payload: { refs: result.refs, quickReplies: result.quickReplies.length },
      });

      return {
        data: result,
        summary: `مسار المحادثة: ${result.stage}`,
        riskLevel: result.escalate ? "HIGH" : "LOW",
      };
    },
  );

  return outcome.data;
}

/** The actual routing/state machine (kept separate so it can be unit-tested). */
export async function routeMessage(input: {
  customer: CustomerRow;
  message: string;
  locale: Locale;
  conversationId?: string | null;
  profileBefore: RequirementProfile;
  stage: JourneyStage;
}): Promise<AssistantTurnResult> {
  const { customer, message, locale } = input;
  const intent = classifyIntent(message);

  // 1) Always merge any new information the client just volunteered.
  const { profile, changed } = await extractRequirements(customer, message, {
    conversationId: input.conversationId ?? null,
  });

  // 2) Questions that belong to support (status, billing, policies, complaints).
  // Support questions are answered at any stage — a client waiting on a summary may
  // still ask about a bill, a policy or their project. Confirmation itself is only
  // accepted through `isConfirmation`, so this cannot approve anything by accident.
  if (isSupportIntent(intent)) {
    const context = await loadSupportContext(customer);
    const answer = await answerSupportQuestion({
      customer,
      message,
      context,
      conversationId: input.conversationId ?? null,
    });
    await persistStage(customer.id, mapSupportStage(input.stage, answer), "facts");
    return {
      reply: answer.text,
      quickReplies: answer.quickReplies,
      stage: mapSupportStage(input.stage, answer),
      language: locale,
      escalate: answer.escalate,
      escalationReason: answer.escalationReason,
      internalNote: `support:${answer.intent}`,
    };
  }

  // 3) Discovery: ask only for the missing slots, one at a time.
  if (profile.missing.length > 0) {
    const question = nextQuestion(profile, locale);
    // Only apologise when nothing at all was understood. A client who just told us
    // something useful gets a short acknowledgement, never "I did not understand".
    const intro = changed
      ? t("noted", locale)
      : profile.goal === null && profile.services.length === 0
        ? t("fallback", locale)
        : "";
    await persistStage(customer.id, "COLLECTING", "facts");
    return {
      reply: [intro, question.text].filter(Boolean).join("\n\n"),
      quickReplies: question.quickReplies,
      stage: "COLLECTING",
      language: locale,
      refs: { conversationStep: question.slot ?? undefined },
      internalNote: `collecting:${question.slot}(${profile.completeness}%)`,
    };
  }

  // 4) Summary confirmation before anything is priced.
  if (input.stage === "COLLECTING" || input.stage === "NEW" || input.stage === "CONFIRMING") {
    const confirmed = isConfirmation(message);
    if (!confirmed) {
      await persistStage(customer.id, "CONFIRMING", "facts");
      // A question deserves an answer, not a repeated form.
      const isQuestion = /[؟?]/.test(message) || /^(لماذا|كيف|متى|هل|ماذا|what|why|how|when|who)\b/i.test(message.trim());
      const intro = isQuestion ? t("waitingReview", locale) : buildSummary(profile, locale);
      return {
        reply: `${intro}\n\n${isQuestion ? buildSummary(profile, locale) + "\n\n" : ""}${t("summaryConfirm", locale)}`,
        quickReplies:
          locale === "ar" ? ["نعم، صحيح", "أريد تعديل شيء"] : ["Yes, that's right", "I want to change something"],
        stage: "CONFIRMING",
        language: locale,
        internalNote: `summary:${profile.completeness}%`,
      };
    }
  }

  // 5) Confirmed → price → proposal → plan.
  const pricing = await priceRequirements(customer, profile);
  return fulfilRequest({ customer, profile, pricing, locale, conversationId: input.conversationId ?? null });
}

/** Generates the priced offer, project and delivery plan, then replies. */
async function fulfilRequest(input: {
  customer: CustomerRow;
  profile: RequirementProfile;
  pricing: PricingOutcome;
  locale: Locale;
  conversationId?: string | null;
}): Promise<AssistantTurnResult> {
  const { customer, profile, pricing, locale } = input;
  const proposal = await buildProposal({
    customer,
    profile,
    pricing,
    locale,
    send: pricing.autoApproved,
  });

  const delivery = await createDeliveryPlan({
    project: proposal.project,
    customer,
    services: pricing.services,
    profile: {
      platforms: profile.platforms,
      volume: profile.volume,
      timelineDays: profile.timelineDays,
    },
    locale,
  });

  await persistStage(customer.id, pricing.autoApproved ? "QUOTED" : "CONFIRMING", "facts");

  const explanation = locale === "ar" ? pricing.clientExplanationAr : pricing.clientExplanationEn;
  const reply = [
    t("offerReady", locale),
    "",
    explanation,
    "",
    locale === "ar"
      ? `رقم العرض: ${proposal.offer.code} • مدة التنفيذ المتوقعة: ${delivery.taskCount > 0 ? pricing.quote.deliveryDays : pricing.quote.deliveryDays} يوم`
      : `Offer reference: ${proposal.offer.code} • Expected delivery: ${pricing.quote.deliveryDays} days`,
    // Draft only: the owner/partner must approve before this offer is sent.
    locale === "ar"
      ? "العرض الآن مسودة تحتاج مراجعة وموافقة المالك قبل إرسالها إليك رسميًا، وسنبلغك فورًا."
      : "This offer is a draft that needs owner review and approval before it is formally sent to you — we'll let you know right away.",
    pricing.escalations.length > 0 ? t("escalation", locale) : "",
    t("privacyNote", locale),
  ]
    .filter(Boolean)
    .join("\n");

  return {
    reply,
    quickReplies:
      locale === "ar" ? ["سياسة الإلغاء والاسترجاع", "تحدث مع الفريق"] : ["Cancellation policy", "Talk to the team"],
    stage: pricing.autoApproved ? "QUOTED" : "CONFIRMING",
    language: locale,
    refs: {
      offerId: proposal.offer.id,
      offerCode: proposal.offer.code,
      projectId: proposal.project.id,
    },
    escalate: proposal.requiresApproval,
    escalationReason: proposal.requiresApproval ? "Offer requires owner/partner approval before sending." : undefined,
    internalNote: `offer:${proposal.offer.code} total=${formatMoney(proposal.offer.total_minor, proposal.offer.currency, "en")}`,
  };
}

/* --------------------------------------------------------------- helpers ---- */

function isSupportIntent(intent: ReturnType<typeof classifyIntent>): boolean {
  return [
    "PROJECT_STATUS",
    "OFFER_QUESTION",
    "BILLING_QUESTION",
    "SUBSCRIPTION_QUESTION",
    "REPORT_QUESTION",
    "DEEP_REPORT_REQUEST",
    "POLICY_QUESTION",
    "COMPLAINT",
    "HUMAN_REQUEST",
    "SERVICE_QUESTION",
  ].includes(intent);
}

function mapSupportStage(
  current: JourneyStage,
  answer: SupportAnswer,
): JourneyStage {
  if (answer.escalate) return current;
  return current === "NEW" ? "COLLECTING" : current;
}

const AFFIRMATIVE_TOKENS = [
  "yes",
  "y",
  "ok",
  "okay",
  "confirm",
  "confirmed",
  "correct",
  "sure",
  "نعم",
  "تمام",
  "صحيح",
  "موافق",
  "أوافق",
  "اوافق",
  "اي",
  "إي",
  "اوك",
  "حسنا",
  "حسنًا",
  "ماشي",
  "زين",
];

/**
 * Detects confirmation of the summary. Tolerates punctuation, diacritics and
 * short sentences such as "نعم، صحيح" or "yes that's right", while refusing long
 * messages that merely contain an affirmative word (those may be change requests).
 */
function isConfirmation(message: string): boolean {
  const normalised = message
    .trim()
    .toLowerCase()
    .replace(/[\u064B-\u0652\u0670]/g, "") // Arabic diacritics
    .replace(/[.,!?،؛:…"'`]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalised) return false;
  const words = normalised.split(" ");
  if (words.length > 5) return false;
  const first = words[0] ?? "";
  if (AFFIRMATIVE_TOKENS.includes(first)) return true;
  // "that is right" / "this is correct" style answers.
  const rightPhrase = /(that|this)( is|'s)? (right|correct)/.test(normalised);
  return AFFIRMATIVE_TOKENS.some((token) => normalised === token) || rightPhrase;
}

export async function loadStage(customer: CustomerRow): Promise<JourneyStage | null> {
  const { factsToMap } = await import("@/lib/repositories/customers.repo");
  const facts = await factsToMap(customer.id);
  const stage = facts.journey_stage as JourneyStage | undefined;
  return stage ?? null;
}

async function persistStage(customerId: string, stage: JourneyStage, source: "facts" | "agent"): Promise<void> {
  try {
    await upsertCustomerFact({
      customer_id: customerId,
      fact_key: "journey_stage",
      fact_value: stage,
      source: source === "facts" ? "AGENT" : "AGENT",
      confidence: 1,
    });
  } catch (error) {
    logger.warn("Could not persist journey stage", { error });
  }
}

/** Called when an offer is approved so the journey moves forward. */
export async function markJourneyApproved(customerId: string): Promise<void> {
  await persistStage(customerId, "APPROVED", "facts");
}

/** Called when delivery starts (payment settled) so the journey reflects reality. */
export async function markJourneyDelivering(customerId: string): Promise<void> {
  await persistStage(customerId, "DELIVERING", "facts");
}
