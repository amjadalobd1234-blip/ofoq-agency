/**
 * Escalation agent — decides WHEN a conversation must reach a human, and writes
 * the record that proves it happened.
 *
 * The assistant used to *say* "your request will be handed to the team" while
 * nothing was written anywhere: no alert, no notification, no email. This module
 * is the missing half. It is deliberately deterministic (no model call) so the
 * decision cannot drift between providers, and it is pure — every side effect
 * (alerts row, conversation status, notifications, owner email) lives in
 * `src/lib/services/escalation.service.ts`.
 *
 * Two things raise an escalation:
 *   HUMAN_REQUEST (URGENT)    the client asked for a person, a call, or
 *                             complained — or the assistant's own reply promised
 *                             a handoff, which the platform must then honour.
 *   NEW_LEAD      (IMPORTANT) the client's need is understood: a service plus at
 *                             least one scoping detail (budget, timeline,
 *                             platforms, volume). The team should see the lead.
 */
import {
  detectBudget,
  detectPlatforms,
  detectPostCount,
  detectServiceHints,
  detectTimelineDays,
  platformLabel,
  serviceLabel,
} from "@/lib/ai/language";
import type { AlertSeverity, Locale } from "@/lib/domain/types";

export type EscalationCategory = "HUMAN_REQUEST" | "NEW_LEAD";
export type EscalationSeverity = Extract<AlertSeverity, "URGENT" | "IMPORTANT">;

export interface EscalationTurn {
  role: "user" | "assistant";
  content: string;
}

export interface EscalationDecision {
  escalate: boolean;
  category: EscalationCategory | null;
  severity: EscalationSeverity | null;
  /** One-line reason for the owner, in both languages. */
  reasonAr: string;
  reasonEn: string;
  /** Machine-readable triggers, stored in `alerts.meta` for auditing. */
  signals: string[];
}

/** Titles required by the platform rules for a client handoff. */
export const ESCALATION_TITLES = {
  ar: "عميل جديد يطلب تواصل",
  en: "New client requesting contact",
} as const;

/** Arabic/English labels used by the admin dashboard. */
export const ESCALATION_CATEGORY_LABELS: Record<EscalationCategory, { ar: string; en: string }> = {
  HUMAN_REQUEST: { ar: "طلب فريق بشري", en: "Human handoff" },
  NEW_LEAD: { ar: "طلب جديد", en: "New lead" },
};

/* -------------------------------------------------------------------------- */
/* Detection                                                                  */
/* -------------------------------------------------------------------------- */

/** "I want a real person" — Arabic (MSA + Iraqi/Gulf), and English. */
const HUMAN_REQUEST_PATTERNS: RegExp[] = [
  /(بشري|بشرية|إنسان|انسان|شخص حقيقي|شخصية حقيقية|موظف|موظفة|فريق بشري)/,
  // "أريد بشر" / "ابغى بشر" / "البشر": the bare word "بشر" as a whole word.
  // \b does not work for Arabic in JavaScript, so the boundaries are explicit.
  /(^|[\s،,.!?؟])(بشر|البشر)(?=$|[\s،,.!?؟])/,
  // "أريد التحدث مع شخص", "أبغى أكلم أحد من الفريق", "كلم موظف"
  /(التحدث|أتحدث|اتحدث|تحدث|أتكلم|اتكلم|أكلم|اكلم|كلم|الكلام)\s+(مع|إلى|الى)\s+(شخص|أحد|احد|موظف|موظفة|مسؤول|الفريق|فريق|أحد من الفريق)/,
  /(أريد|اريد|ابي|أبي|ابغى|أبغى|ابغي|أبغي|ودي|أودّ|اود)\s+(شخص|أحد|احد|موظف|مسؤول)(?=$|[\s،,.!?؟])/,
  /(أتكلم|اتكلم|أحچي|احچي|أتحدث|اتحدث|أكلم|اكلم|أريد أحد|اريد احد|ابي واحد)/,
  /(كلمني|اتصل بي|اتصلو بي|رقمكم|رقم الهاتف|واتس|واتساب|whatsapp)/,
  /\b(human|real person|someone|somebody|agent|representative|manager|staff)\b/,
  /\b(call me|phone me|talk to|speak (to|with)|contact me|reach me)\b/,
];

/** Dissatisfaction always needs a person, never another automated answer. */
const COMPLAINT_PATTERNS: RegExp[] = [
  /(شكوى|شكوي|غير راضي|مو راضي|زعلان|مستاء|سيء|سيئة|غش|نصب|احتيال|ما ردوا|ماحد رد)/,
  /\b(complaint|angry|upset|disappointed|unacceptable|scam|fraud|terrible|worst|no one (replied|responded))\b/,
];

/**
 * The assistant promising a handoff.
 *
 * If a reply tells the client the team has been notified, that promise is a
 * contract: the platform raises the escalation so the sentence stays true.
 */
const HANDOFF_CLAIM_PATTERNS: RegExp[] = [
  /(تم تحويل|سيتم تحويل|تحويل طلبك|أبلغت الفريق|أبلغنا الفريق|سيتم إبلاغ|سيتواصل معك|سيتواصل فريقنا|فريقنا سيتواصل|سينظر فريقنا|إلى الفريق البشري)/,
  /\b(transferred|hand(ed)? (over|off)|our team will (contact|reach|follow up)|team has been notified|escalated (this|your)|someone from our team)\b/i,
];

/** A message that only greets or thanks carries no lead. */
const SMALL_TALK_PATTERN =
  /^(hi|hello|hey|ok|okay|thanks|thank you|مرحبا|مرحبًا|السلام عليكم|اهلا|أهلًا|هاي|شكرا|شكرًا|تمام|نعم|لا)[\s!.،؟?]*$/i;

export interface DetectEscalationInput {
  /** The client message that triggered this turn. */
  latestMessage: string;
  /** The conversation so far, oldest first (may already include `latestMessage`). */
  history?: EscalationTurn[];
  /** The assistant reply about to be saved, used to honour its own promises. */
  assistantReply?: string | null;
}

/**
 * Decides whether this turn must reach a human.
 *
 * Never throws: an unparseable message simply does not escalate, because a
 * false alert costs the owner's attention while a missed one costs a client.
 */
export function detectEscalation(input: DetectEscalationInput): EscalationDecision {
  const latest = (input.latestMessage ?? "").trim();
  const lower = latest.toLowerCase();
  const reply = (input.assistantReply ?? "").trim();
  const signals: string[] = [];

  const asksHuman = HUMAN_REQUEST_PATTERNS.some((pattern) => pattern.test(lower));
  if (asksHuman) signals.push("client_asked_for_human");

  const complains = COMPLAINT_PATTERNS.some((pattern) => pattern.test(lower));
  if (complains) signals.push("client_complaint");

  const replyPromised = HANDOFF_CLAIM_PATTERNS.some((pattern) => pattern.test(reply));
  if (replyPromised) signals.push("assistant_promised_handoff");

  if (asksHuman || complains || replyPromised) {
    const reasonAr = complains
      ? "العميل غير راضٍ ويحتاج متابعة بشرية"
      : asksHuman
        ? "العميل طلب صراحةً التواصل مع فريق بشري"
        : "المساعد وعد العميل بتحويل المحادثة إلى الفريق";
    const reasonEn = complains
      ? "The client is unhappy and needs a human follow-up"
      : asksHuman
        ? "The client explicitly asked for a human team member"
        : "The assistant promised the client a handoff to the team";
    return {
      escalate: true,
      category: "HUMAN_REQUEST",
      severity: "URGENT",
      reasonAr,
      reasonEn,
      signals,
    };
  }

  const lead = analyseLead({ latestMessage: latest, history: input.history ?? [] });
  if (lead.complete) {
    return {
      escalate: true,
      category: "NEW_LEAD",
      severity: "IMPORTANT",
      reasonAr: `اكتمل فهم الاحتياج: ${lead.factsAr.join("، ")}`,
      reasonEn: `The brief is understood: ${lead.factsEn.join(", ")}`,
      signals: [...signals, ...lead.signals],
    };
  }

  return { escalate: false, category: null, severity: null, reasonAr: "", reasonEn: "", signals };
}

export interface LeadFacts {
  services: string[];
  platforms: string[];
  budgetAr?: string;
  timelineDays?: number;
  postCount?: number;
}

/**
 * "Do we understand the need yet?" — a service plus at least one scoping detail.
 *
 * Deliberately conservative: a bare "I want marketing" is not a lead, because
 * the assistant still has to ask what for. The moment a platform, a budget, a
 * deadline or a volume appears next to a service, the owner should know.
 */
export function analyseLead(input: {
  latestMessage: string;
  history: EscalationTurn[];
}): { complete: boolean; factsAr: string[]; factsEn: string[]; signals: string[]; facts: LeadFacts } {
  const clientText = [
    ...input.history.filter((turn) => turn.role === "user").map((turn) => turn.content),
    input.latestMessage,
  ]
    .filter((line) => line.trim().length > 0 && !SMALL_TALK_PATTERN.test(line.trim()))
    .join("\n");

  const services = [...new Set(detectServiceHints(clientText))];
  const platforms = [...new Set(detectPlatforms(clientText))];
  const budget = detectBudget(clientText);
  const timelineDays = detectTimelineDays(clientText) ?? undefined;
  const postCount = detectPostCount(clientText) ?? undefined;

  const facts: LeadFacts = { services, platforms, timelineDays, postCount };
  const factsAr: string[] = [];
  const factsEn: string[] = [];
  const signals: string[] = [];

  if (services.length > 0) {
    factsAr.push(`الخدمة: ${services.map((slug) => serviceLabel(slug, "ar")).join("، ")}`);
    factsEn.push(`service: ${services.map((slug) => serviceLabel(slug, "en")).join(", ")}`);
    signals.push(`service:${services.join("|")}`);
  }
  if (platforms.length > 0) {
    factsAr.push(`المنصات: ${platforms.map((key) => platformLabel(key, "ar")).join("، ")}`);
    factsEn.push(`platforms: ${platforms.map((key) => platformLabel(key, "en")).join(", ")}`);
    signals.push(`platforms:${platforms.join("|")}`);
  }
  if (budget && (budget.min || budget.max)) {
    const currency = budget.currency ?? "USD";
    const value = budget.min === budget.max || !budget.min ? `${budget.max}` : `${budget.min}–${budget.max}`;
    facts.budgetAr = `${value} ${currency}`;
    factsAr.push(`الميزانية: ${facts.budgetAr}`);
    factsEn.push(`budget: ${value} ${currency}`);
    signals.push("budget_declared");
  }
  if (timelineDays) {
    factsAr.push(`المدة: ${timelineDays} يوم`);
    factsEn.push(`timeline: ${timelineDays} days`);
    signals.push(`timeline:${timelineDays}d`);
  }
  if (postCount) {
    factsAr.push(`الحجم: ${postCount} منشور`);
    factsEn.push(`volume: ${postCount} posts`);
    signals.push(`posts:${postCount}`);
  }

  const hasScope = platforms.length > 0 || Boolean(facts.budgetAr) || Boolean(timelineDays) || Boolean(postCount);
  return { complete: services.length > 0 && hasScope, factsAr, factsEn, signals, facts };
}

/* -------------------------------------------------------------------------- */
/* Conversation summary (the alert body)                                      */
/* -------------------------------------------------------------------------- */

export interface ConversationSummary {
  /** Arabic body for the alert: what the client actually said. */
  ar: string;
  /**
   * English body. The client's words are kept verbatim (never machine-guessed
   * into a different meaning) and wrapped with the structured facts extracted
   * from the conversation, so a non-Arabic reader still knows what is needed.
   */
  en: string;
  clientLines: string[];
  facts: LeadFacts;
}

const MAX_LINES = 6;
const MAX_LINE_LENGTH = 300;
const MAX_BODY_LENGTH = 1_400;

/** Builds the bilingual alert body from the conversation itself. */
export function summariseConversation(input: {
  history?: EscalationTurn[];
  latestMessage: string;
  locale?: Locale;
}): ConversationSummary {
  const lines = [
    ...(input.history ?? []).filter((turn) => turn.role === "user").map((turn) => turn.content.trim()),
    input.latestMessage.trim(),
  ]
    .filter((line) => line.length > 0)
    .slice(-MAX_LINES)
    .map((line) => (line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line));

  const lead = analyseLead({ latestMessage: input.latestMessage, history: input.history ?? [] });
  const quoted = lines.map((line) => `• ${line}`).join("\n");

  const ar = clip(
    [
      `طلب العميل: ${input.latestMessage.trim().slice(0, MAX_LINE_LENGTH)}`,
      lead.factsAr.length > 0 ? `ما فهمناه: ${lead.factsAr.join("، ")}` : "",
      "آخر رسائل العميل:",
      quoted,
    ]
      .filter(Boolean)
      .join("\n"),
  );

  const en = clip(
    [
      "Auto-generated summary of an Ofoq assistant conversation.",
      lead.factsEn.length > 0 ? `Understood brief — ${lead.factsEn.join("; ")}.` : "No structured brief detected yet.",
      "Client messages (original wording):",
      quoted,
    ]
      .filter(Boolean)
      .join("\n"),
  );

  return { ar, en, clientLines: lines, facts: lead.facts };
}

function clip(value: string): string {
  return value.length > MAX_BODY_LENGTH ? `${value.slice(0, MAX_BODY_LENGTH)}…` : value;
}

/* -------------------------------------------------------------------------- */
/* Alert payload                                                              */
/* -------------------------------------------------------------------------- */

export interface EscalationAlertPayload {
  severity: EscalationSeverity;
  category: EscalationCategory;
  title_ar: string;
  title_en: string;
  body_ar: string;
  body_en: string;
  entity_type: "conversation";
  target_role: "ANY_STAFF";
  meta: {
    source: "escalation-agent";
    reasonAr: string;
    reasonEn: string;
    signals: string[];
  };
}

/** The exact `alerts` row an escalation must produce. */
export function escalationAlertPayload(
  decision: EscalationDecision,
  summary: ConversationSummary,
): EscalationAlertPayload {
  const category: EscalationCategory = decision.category ?? "HUMAN_REQUEST";
  const severity: EscalationSeverity = decision.severity ?? "IMPORTANT";
  const label = ESCALATION_CATEGORY_LABELS[category];

  return {
    severity,
    category,
    title_ar: ESCALATION_TITLES.ar,
    title_en: ESCALATION_TITLES.en,
    body_ar: clip(`[${label.ar}] ${decision.reasonAr}\n\n${summary.ar}`),
    body_en: clip(`[${label.en}] ${decision.reasonEn}\n\n${summary.en}`),
    entity_type: "conversation",
    target_role: "ANY_STAFF",
    meta: {
      source: "escalation-agent",
      reasonAr: decision.reasonAr,
      reasonEn: decision.reasonEn,
      signals: decision.signals,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* What the client is told                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The line appended to the assistant reply.
 *
 * It is only ever chosen from a real outcome: `confirmed` after the alert row,
 * the conversation status and the owner email were attempted, `failed` when the
 * platform could not record the handoff. The client is never told something
 * happened when it did not.
 */
export function handoffNotice(locale: Locale, outcome: "confirmed" | "failed"): string {
  if (outcome === "confirmed") {
    return locale === "en"
      ? "✔ Your conversation has been handed over to the Ofoq human team: an urgent alert was created in the agency control room and the owner was notified by email. A team member will contact you shortly."
      : "✔ تم تحويل محادثتك إلى فريق أفق البشري: أُنشئ تنبيه في لوحة الوكالة وتم إشعار المالك بالبريد الإلكتروني. سيتواصل معك أحد أعضاء الفريق قريبًا.";
  }
  return locale === "en"
    ? "Your message is saved in this conversation and is visible to the Ofoq team, but the live handoff alert could not be recorded right now. Please keep your details here and the team will pick it up."
    : "رسالتك محفوظة في هذه المحادثة ويطلع عليها فريق أفق، لكن تعذّر تسجيل تنبيه التحويل المباشر الآن. اترك تفاصيلك هنا وسيتابعها الفريق.";
}
