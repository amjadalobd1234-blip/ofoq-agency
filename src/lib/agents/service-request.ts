/**
 * The guided service request — questions, hybrid option matching and the
 * client-facing messages — kept free of React so it can be unit-tested and
 * reused by the API routes.
 *
 * The client is asked only four basic questions, in this order:
 *
 *   1. TYPE      — نوع الخدمة
 *   2. SIZE      — حجم الخدمة
 *   3. BUDGET    — الميزانية
 *   4. TARGETING — المنطقة المستهدفة
 *
 * then the request summary and the pricing message are shown, and finally the
 * contact channel (CONTACT) is asked. Platforms, delivery time, business type
 * and product price are no longer asked: delivery is planned as normal, and the
 * number of platforms is derived from the budget.
 *
 * Understanding what the client types happens in three layers:
 *
 *   1. exact match against the option id / Arabic label / English label,
 *   2. partial match for phrases such as «أريد تصميم» or «تصميم شعار»,
 *   3. AI intent extraction (`extractServiceTypeIntent`) when the first two
 *      layers fail — the answer is only accepted when it names a real option.
 *
 * Text is normalised first: diacritics removed, hamza forms unified, letter
 * variants folded and repeated spaces collapsed.
 */
import type { Locale } from "@/lib/domain/types";
import {
  adDaysForBudget,
  calculateServiceEstimate,
  formatCount,
  formatCountRange,
  formatUsdRange,
  isolateLtr,
  type BudgetBand,
  type PlatformScope,
  type PricingInput,
  type PricingServiceType,
  type ProjectSize,
  type TargetingArea,
} from "./pricing-agent";
import { budgetBandForAmount, parseStoredBudget, type BudgetDetail, type BudgetKind } from "./budget-parser";

export type { BudgetDetail } from "./budget-parser";

/* ------------------------------------------------------------------ steps --- */

export type ServiceRequestStep = "TYPE" | "SIZE" | "BUDGET" | "TARGETING" | "SUMMARY" | "CONTACT" | "PHONE" | "DONE";

/** The four basic questions, in the requested order. */
export const SERVICE_REQUEST_BASIC_STEPS = ["TYPE", "SIZE", "BUDGET", "TARGETING"] as const;

export const SERVICE_REQUEST_STEPS: readonly ServiceRequestStep[] = [
  "TYPE",
  "SIZE",
  "BUDGET",
  "TARGETING",
  "SUMMARY",
  "CONTACT",
  "PHONE",
  "DONE",
];

/** Every step except SUMMARY/DONE asks something (a question or a phone number). */
export type ServiceRequestQuestionStep = "TYPE" | "SIZE" | "BUDGET" | "TARGETING" | "CONTACT";
/**
 * `budget` is always one of the four band ids. When the client typed a value
 * or a range instead of pressing a band, `budgetRange` keeps the canonical text
 * (`200-500` / `350`) and `budgetAmount` the planning amount (`500` / `350`).
 */
export type ServiceRequestAnswerKey =
  | "type"
  | "size"
  | "budget"
  | "budgetRange"
  | "budgetAmount"
  | "targeting"
  | "contact"
  | "phone";
export type ServiceRequestAnswers = Partial<Record<ServiceRequestAnswerKey, string>>;

export type ContactChannel = "whatsapp" | "email" | "website";

export interface ServiceRequestOption {
  id: string;
  labelAr: string;
  labelEn: string;
}

export interface ServiceRequestQuestion {
  step: ServiceRequestQuestionStep;
  answerKey: ServiceRequestAnswerKey;
  question: Record<Locale, string>;
  options: ServiceRequestOption[];
}

/**
 * Shape of the order reference (`OFOQ-<year>-<sequence>`). The real code is
 * issued by the database when the request is saved; this sample is what the
 * tests' stubbed API returns.
 */
export const SERVICE_REQUEST_ORDER_CODE = "OFOQ-2026-001";

const TYPE_OPTIONS: ServiceRequestOption[] = [
  { id: "design", labelAr: "تصميم", labelEn: "Design" },
  { id: "ads", labelAr: "إعلانات", labelEn: "Ads" },
  { id: "social_media", labelAr: "سوشيال ميديا", labelEn: "Social media" },
  { id: "content", labelAr: "محتوى", labelEn: "Content" },
  { id: "seo", labelAr: "SEO", labelEn: "SEO" },
  { id: "other", labelAr: "غير ذلك", labelEn: "Other" },
];

const SIZE_OPTIONS: ServiceRequestOption[] = [
  { id: "small", labelAr: "صغير", labelEn: "Small" },
  { id: "medium", labelAr: "متوسط", labelEn: "Medium" },
  { id: "large", labelAr: "كبير", labelEn: "Large" },
];

const BUDGET_OPTIONS: ServiceRequestOption[] = [
  { id: "under_200", labelAr: "أقل من 200$", labelEn: "Under $200" },
  { id: "200_500", labelAr: "200-500$", labelEn: "$200-500" },
  { id: "500_1500", labelAr: "500-1500$", labelEn: "$500-1500" },
  { id: "over_1500", labelAr: "أكثر من 1500$", labelEn: "Over $1500" },
];

const TARGETING_OPTIONS: ServiceRequestOption[] = [
  { id: "iraq_all", labelAr: "🇮🇶 العراق كله", labelEn: "🇮🇶 All Iraq" },
  { id: "baghdad", labelAr: "🏙️ بغداد فقط", labelEn: "🏙️ Baghdad only" },
  { id: "basra", labelAr: "🌊 البصرة فقط", labelEn: "🌊 Basra only" },
  { id: "three_cities", labelAr: "🏙️ بغداد + البصرة + أربيل", labelEn: "🏙️ Baghdad + Basra + Erbil" },
  { id: "gulf", labelAr: "🌍 الخليج (السعودية، الإمارات، الكويت)", labelEn: "🌍 Gulf (Saudi Arabia, UAE, Kuwait)" },
  { id: "arabic_global", labelAr: "🌐 عربي عام", labelEn: "🌐 General Arabic-speaking audience" },
];

const CONTACT_OPTIONS: ServiceRequestOption[] = [
  { id: "whatsapp", labelAr: "📱 واتساب", labelEn: "📱 WhatsApp" },
  { id: "email", labelAr: "📧 إيميل", labelEn: "📧 Email" },
  { id: "website", labelAr: "💬 إشعار في الموقع", labelEn: "💬 In-app notification" },
];

export const SERVICE_REQUEST_QUESTIONS: Record<ServiceRequestQuestionStep, ServiceRequestQuestion> = {
  TYPE: {
    step: "TYPE",
    answerKey: "type",
    question: { ar: "شنو نوع الخدمة اللي تحتاجها؟", en: "What type of service do you need?" },
    options: TYPE_OPTIONS,
  },
  SIZE: {
    step: "SIZE",
    answerKey: "size",
    question: { ar: "شكد حجم المشروع؟", en: "How big is the project?" },
    options: SIZE_OPTIONS,
  },
  BUDGET: {
    step: "BUDGET",
    answerKey: "budget",
    question: { ar: "شنو الميزانية التقريبية؟", en: "What is your approximate budget?" },
    options: BUDGET_OPTIONS,
  },
  TARGETING: {
    step: "TARGETING",
    answerKey: "targeting",
    question: { ar: "وين تريد تستهدف إعلانك؟", en: "Where would you like to target your campaign?" },
    options: TARGETING_OPTIONS,
  },
  CONTACT: {
    step: "CONTACT",
    answerKey: "contact",
    question: { ar: "كيف تحب يتواصل معك فريق أفق؟", en: "How would you like the Ofoq team to contact you?" },
    options: CONTACT_OPTIONS,
  },
};

/** The services the TYPE question offers, as the pricing agent's types. */
export const SERVICE_TYPE_BY_OPTION: Record<string, PricingServiceType> = {
  design: "design",
  ads: "ads",
  social_media: "social",
  content: "content",
  seo: "seo",
  other: "other",
};

export function isQuestionStep(step: ServiceRequestStep): step is ServiceRequestQuestionStep {
  return step === "TYPE" || step === "SIZE" || step === "BUDGET" || step === "TARGETING" || step === "CONTACT";
}

/* --------------------------------------------------------------- matching --- */

/**
 * Normalises Arabic/English option text before comparing it:
 * diacritics and tatweel removed, hamza forms unified (أ/إ/آ → ا), ة → ه,
 * ى → ي, punctuation dropped, whitespace collapsed and case folded.
 */
export function normalizeOptionText(value: string): string {
  return (value ?? "")
    .toString()
    .toLowerCase()
    // Arabic diacritics, tatweel and the superscript alef.
    .replace(/[\u064B-\u0652\u0670\u0640]/g, "")
    // أ إ آ ٱ → ا, and the other letter variants the Iraqi keyboard produces.
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/[ىئ]/g, "ي")
    .replace(/ؤ/g, "و")
    // Punctuation, emoji and symbols never take part in matching.
    .replace(/[^\p{L}\p{N}\s$]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** An option in the shape the matcher works with. */
export interface MatchableOption {
  /** Language-independent id of the option (`design`, `ads`, …). */
  value: string;
  labelAr: string;
  labelEn: string;
}

export function toMatchable(option: ServiceRequestOption): MatchableOption {
  return { value: option.id, labelAr: option.labelAr, labelEn: option.labelEn };
}

/** Shortest input the partial layer accepts, so one stray letter matches nothing. */
const MIN_PARTIAL_LENGTH = 3;

/**
 * Hybrid match of a typed phrase against a list of options.
 *
 *   1. exact match (id, Arabic label or English label, normalised),
 *   2. partial match (the option appears inside the phrase, or the phrase
 *      inside the option) — the layer that understands «أريد تصميم»,
 *   3. `null`, which lets the caller try AI intent extraction.
 */
export function matchOption<T extends MatchableOption>(text: string, options: readonly T[]): T | null {
  const normalized = normalizeOptionText(text);
  if (!normalized) return null;

  // 1. مطابقة كاملة — id / Arabic label / English label.
  for (const option of options) {
    if (
      normalized === normalizeOptionText(option.value) ||
      normalized === normalizeOptionText(option.labelAr) ||
      normalized === normalizeOptionText(option.labelEn)
    ) {
      return option;
    }
  }

  // 2. مطابقة جزئية — the option inside a longer phrase, or vice versa.
  if (normalized.length < MIN_PARTIAL_LENGTH) return null;
  for (const option of options) {
    const value = normalizeOptionText(option.value);
    const labelAr = normalizeOptionText(option.labelAr);
    const labelEn = normalizeOptionText(option.labelEn);

    if (
      (labelAr.length >= MIN_PARTIAL_LENGTH && normalized.includes(labelAr)) ||
      (labelEn.length >= MIN_PARTIAL_LENGTH && normalized.includes(labelEn)) ||
      (value.length >= MIN_PARTIAL_LENGTH && normalized.includes(value)) ||
      (labelAr.length >= MIN_PARTIAL_LENGTH && labelAr.includes(normalized)) ||
      (value.length >= MIN_PARTIAL_LENGTH && value.includes(normalized))
    ) {
      return option;
    }
  }

  return null; // عندها تُجرّب مطابقة النية عبر الذكاء الاصطناعي
}

/** The option id of `step` a typed message stands for, or `null`. */
export function matchServiceOption(step: ServiceRequestQuestionStep, text: string): string | null {
  const match = matchOption(text, SERVICE_REQUEST_QUESTIONS[step].options.map(toMatchable));
  return match?.value ?? null;
}

/** The TYPE options as id/label pairs — used by the AI intent layer too. */
export function serviceTypeOptions(): MatchableOption[] {
  return TYPE_OPTIONS.map(toMatchable);
}

export function serviceRequestOption(step: ServiceRequestQuestionStep, optionId: string | undefined): ServiceRequestOption | undefined {
  if (!optionId) return undefined;
  return SERVICE_REQUEST_QUESTIONS[step].options.find((option) => option.id === optionId);
}

export function optionLabel(step: ServiceRequestQuestionStep, optionId: string | undefined, locale: Locale): string {
  const option = serviceRequestOption(step, optionId);
  if (!option) return optionId ?? "";
  return locale === "ar" ? option.labelAr : option.labelEn;
}

/* ------------------------------------------------------------------ flow ---- */

export interface ServiceRequestAnswerEvent {
  step: ServiceRequestStep;
  answeredAt: string;
  /** A budget changed after it was first answered («طيب من 200 إلى 500»). */
  revision?: boolean;
}

export interface ServiceRequestState {
  step: ServiceRequestStep;
  answers: ServiceRequestAnswers;
  answerLog: ServiceRequestAnswerEvent[];
  /** Set when the client picked WhatsApp and the number passed validation. */
  completedAt?: string | null;
}

export function createServiceRequestState(): ServiceRequestState {
  return { step: "TYPE", answers: {}, answerLog: [], completedAt: null };
}

/** The step that follows each of the four basic questions. */
const NEXT_QUESTION_STEP: Record<"TYPE" | "SIZE" | "BUDGET" | "TARGETING", ServiceRequestStep> = {
  TYPE: "SIZE",
  SIZE: "BUDGET",
  BUDGET: "TARGETING",
  TARGETING: "SUMMARY",
};

/**
 * The question the client is currently expected to answer. While the request is
 * on SUMMARY the summary and the pricing message are on screen, so the open
 * question is the contact channel.
 */
export function currentQuestionStep(state: ServiceRequestState): ServiceRequestQuestionStep | null {
  if (state.step === "SUMMARY") return "CONTACT";
  return isQuestionStep(state.step) ? state.step : null;
}

/**
 * Records the answer to the open question and moves to the next step.
 *
 * Anything that is not one of the offered options is rejected (the state is
 * returned unchanged), so a free-text guess can never be stored as an answer.
 */
export function answerServiceRequest(
  state: ServiceRequestState,
  optionId: string,
  at: string = new Date().toISOString(),
  detail: { budget?: BudgetDetail | null } = {},
): ServiceRequestState {
  const step = currentQuestionStep(state);
  if (!step) return state;
  const option = serviceRequestOption(step, optionId);
  if (!option) return state;

  const answers: ServiceRequestAnswers = { ...state.answers, [SERVICE_REQUEST_QUESTIONS[step].answerKey]: option.id };
  if (step === "BUDGET") applyBudgetDetail(answers, option.id, detail.budget);
  const answerLog: ServiceRequestAnswerEvent[] = [...state.answerLog, { step, answeredAt: at }];

  if (step === "CONTACT") {
    // WhatsApp needs the number first; email and the in-app notification are
    // complete the moment the channel is chosen.
    const next: ServiceRequestStep = option.id === "whatsapp" ? "PHONE" : "DONE";
    return { ...state, step: next, answers, answerLog, completedAt: next === "DONE" ? at : null };
  }

  const next: ServiceRequestStep = NEXT_QUESTION_STEP[step];
  return { ...state, step: next, answers, answerLog };
}

/**
 * Stores a typed budget next to its band, or clears the typed details when a
 * band button was pressed. The canonical text is always `min-max` (`200-500`),
 * never the words the client used («500 من 200» is impossible here).
 */
function applyBudgetDetail(answers: ServiceRequestAnswers, band: string, detail: BudgetDetail | null | undefined): void {
  const stored = detail ? parseStoredBudget(detail.range) : null;
  const amount = detail ? Math.round(detail.amount) : 0;
  // The text and the amount must be exactly the ones the parser derives from
  // each other — an open budget («>500» planned on its published $1,000)
  // included. Anything else keeps the band alone and drops the details.
  const consistent =
    stored !== null &&
    Number.isFinite(detail?.amount) &&
    amount > 0 &&
    stored.amount === amount &&
    stored.band === band;
  if (consistent) {
    answers.budgetRange = stored.text;
    answers.budgetAmount = String(amount);
  } else {
    delete answers.budgetRange;
    delete answers.budgetAmount;
  }
}

/**
 * Steps at which a budget already given may still be changed in the
 * conversation: while a question is open, while the WhatsApp number is
 * expected, and after the request was completed — «اريد الميزانية أكثر من 500»
 * typed at the end is a budget update, never a question for the assistant.
 */
const BUDGET_REVISION_STEPS: ReadonlySet<ServiceRequestStep> = new Set(["TARGETING", "SUMMARY", "PHONE", "DONE"]);

/** True when a new budget message may update the request instead of being rejected. */
export function canReviseBudget(state: ServiceRequestState): boolean {
  return Boolean(state.answers.budget) && BUDGET_REVISION_STEPS.has(state.step);
}

/**
 * Updates the budget after it was answered — «طيب من 200 إلى 500» while the
 * targeting question or the contact channel is open. The step does not move:
 * the open question stays open, and the summary/pricing are recalculated from
 * the new budget. Returns the state unchanged when a revision is not possible.
 */
export function reviseBudget(
  state: ServiceRequestState,
  budget: BudgetDetail,
  at: string = new Date().toISOString(),
): ServiceRequestState {
  if (!canReviseBudget(state)) return state;
  const stored = parseStoredBudget(budget.range);
  const amount = Math.round(budget.amount);
  if (!stored || !Number.isFinite(budget.amount) || amount <= 0 || stored.amount !== amount) return state;
  const answers: ServiceRequestAnswers = { ...state.answers, budget: stored.band };
  applyBudgetDetail(answers, stored.band, { range: stored.text, amount: stored.amount });
  return {
    ...state,
    answers,
    answerLog: [...state.answerLog, { step: "BUDGET", answeredAt: at, revision: true }],
  };
}

/** The band id and planning details of a typed budget. */
export function budgetAnswerFor(budget: BudgetDetail): { band: BudgetBand; detail: BudgetDetail } {
  return { band: parseStoredBudget(budget.range)?.band ?? budgetBandForAmount(budget.amount), detail: budget };
}

/** WhatsApp number rules: 10–15 digits, starting with 07, +964 or 964. */
export function isValidWhatsappNumber(raw: string): boolean {
  const value = raw.trim();
  if (!value) return false;
  const digits = value.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) return false;
  return digits.startsWith("07") || digits.startsWith("964") || value.startsWith("+964");
}

export const WHATSAPP_NUMBER_REJECTED: Record<Locale, string> = {
  ar: "الرقم غير صحيح، حاول مرة ثانية",
  en: "That number is not valid, please try again",
};

/**
 * Saves the WhatsApp number when it is valid and completes the request;
 * otherwise the client stays on the phone step and receives the rejection
 * message — no value is stored.
 */
export function submitWhatsappNumber(
  state: ServiceRequestState,
  raw: string,
  at: string = new Date().toISOString(),
): { state: ServiceRequestState; error: string | null } {
  const value = raw.trim();
  if (!isValidWhatsappNumber(value)) {
    return { state, error: WHATSAPP_NUMBER_REJECTED.ar };
  }
  return {
    state: { ...state, step: "DONE", answers: { ...state.answers, phone: value }, completedAt: at },
    error: null,
  };
}

/**
 * True once the four basic questions are answered — the point where the summary
 * and the pricing message are shown. The contact channel is asked afterwards.
 */
export function isServiceRequestComplete(answers: ServiceRequestAnswers): boolean {
  return SERVICE_REQUEST_BASIC_STEPS.every((step) => Boolean(answers[SERVICE_REQUEST_QUESTIONS[step].answerKey]));
}

export interface ServiceRequestReplayEvent {
  step: ServiceRequestStep;
  optionId?: string;
  answeredAt: string;
  /** Budget typed instead of pressed (first answer or a later revision). */
  budget?: BudgetDetail | null;
  revision?: boolean;
}

/**
 * Rebuilds the guided request from its answer log. Returns `null` when the log
 * cannot have produced the answers it claims (edited session storage, an answer
 * that is no longer an option, a phone number that is not valid), so a tampered
 * request restarts from the first question instead of pricing nonsense.
 */
export function replayServiceRequest(
  log: ServiceRequestReplayEvent[],
  answers: ServiceRequestAnswers,
): ServiceRequestState | null {
  const states = replayStates(log, answers);
  if (!states) return null;
  const state = states.length > 0 ? states[states.length - 1]! : createServiceRequestState();
  // The stored budget details must be the ones the log produces.
  if ((state.answers.budgetRange ?? null) !== (answers.budgetRange ?? null)) return null;
  if ((state.answers.budgetAmount ?? null) !== (answers.budgetAmount ?? null)) return null;
  return state;
}

/**
 * The state reached after each event of a valid log — what the conversation
 * showed at that moment (the first summary with the first budget, the revised
 * summary with the new one). `null` when the log is not valid.
 */
export function replayServiceRequestStates(
  log: ServiceRequestReplayEvent[],
  answers: ServiceRequestAnswers,
): ServiceRequestState[] | null {
  return replayStates(log, answers);
}

function replayStates(log: ServiceRequestReplayEvent[], answers: ServiceRequestAnswers): ServiceRequestState[] | null {
  const states: ServiceRequestState[] = [];
  let state = createServiceRequestState();
  for (const event of log) {
    if (event.step === "PHONE") {
      const attempt = submitWhatsappNumber(state, answers.phone ?? "", event.answeredAt);
      if (attempt.error) return null;
      state = attempt.state;
      states.push(state);
      continue;
    }
    if (event.step === "BUDGET" && event.revision) {
      if (!event.budget || !canReviseBudget(state)) return null;
      const revised = reviseBudget(state, event.budget, event.answeredAt);
      if (revised === state) return null;
      state = revised;
      states.push(state);
      continue;
    }
    const question = SERVICE_REQUEST_QUESTIONS[event.step as ServiceRequestQuestionStep];
    if (!question || !event.optionId) return null;
    if (currentQuestionStep(state) !== event.step) return null;
    const before = state.step;
    state = answerServiceRequest(state, event.optionId, event.answeredAt, { budget: event.budget ?? null });
    if (state.step === before) return null;
    if (state.answers[question.answerKey] !== event.optionId) return null;
    states.push(state);
  }
  return states;
}

/** True once a contact channel was chosen (and, for WhatsApp, the number saved). */
export function isServiceRequestSubmitted(answers: ServiceRequestAnswers): boolean {
  if (!answers.contact) return false;
  if (answers.contact === "whatsapp") return Boolean(answers.phone);
  return answers.contact === "email" || answers.contact === "website";
}

/**
 * The pricing agent's input, built only from values the questions offered —
 * plus the exact planning amount when the budget was typed (the upper bound of
 * «من 200 إلى 500», or the single value), which must fall inside the stored band.
 */
export function requestPricingInput(answers: ServiceRequestAnswers): PricingInput {
  const budget: BudgetBand = isBudgetBand(answers.budget) ? answers.budget : "under_200";
  const targeting = SERVICE_REQUEST_QUESTIONS.TARGETING.options.some((option) => option.id === answers.targeting)
    ? (answers.targeting as TargetingArea)
    : "iraq_all";
  const typed = typedBudget(answers);
  return {
    type: SERVICE_TYPE_BY_OPTION[answers.type ?? "other"] ?? "other",
    size: answers.size === "small" || answers.size === "large" ? answers.size : "medium",
    budget,
    targeting,
    budgetAmount: typed?.amount ?? null,
  };
}

function isBudgetBand(value: string | undefined): value is BudgetBand {
  return value === "under_200" || value === "200_500" || value === "500_1500" || value === "over_1500";
}

/** The typed budget of a request, as stored in its answers. */
export interface TypedBudget extends BudgetDetail {
  kind: BudgetKind;
  /** Lower bound of the stated budget («أكثر من 500» → 500; «أقل من 200» → 0). */
  min: number;
  /** Upper bound («200-500» → 500; «أكثر من 500» → the band's ceiling). */
  max: number;
  /** The client's own number of an open budget, null for closed ones. */
  stated: number | null;
  /** The published band the planning amount falls in. */
  band: BudgetBand;
}

/**
 * The typed budget of the request (`{ range: "200-500", amount: 500 }`, or
 * `{ range: ">500", amount: 1000 }` for «أكثر من 500»), or `null` when a band
 * button was pressed or the stored details are inconsistent (an unknown text,
 * an amount the text does not derive, a band that is not the amount's).
 */
export function typedBudget(answers: ServiceRequestAnswers): TypedBudget | null {
  if (!isBudgetBand(answers.budget)) return null;
  const stored = parseStoredBudget(answers.budgetRange);
  const amount = Number(answers.budgetAmount);
  if (!stored || !Number.isFinite(amount) || amount <= 0) return null;
  if (stored.amount !== Math.round(amount)) return null;
  if (stored.band !== answers.budget) return null;
  return {
    range: stored.text,
    amount: stored.amount,
    kind: stored.kind,
    min: stored.min,
    max: stored.max,
    stated: stored.stated,
    band: stored.band,
  };
}

/**
 * The budget as the client reads it — exactly the shape they gave, never the
 * planning amount standing in for it:
 *
 *   typed range    «200-500$»        single value  «350$»
 *   typed floor    «أكثر من 500$»    typed ceiling «أقل من 200$»
 *   pressed button the button's own label («200-500$», «أكثر من 1500$»)
 *
 * Ranges are isolated for Arabic (`isolateLtr`) so the two ends keep their
 * smallest-first order on screen; the stored order is always smallest first, so
 * «500 من 200» cannot be produced.
 */
export function budgetDisplayText(answers: ServiceRequestAnswers, locale: Locale): string {
  const typed = typedBudget(answers);
  if (typed) {
    const ar = locale === "ar";
    if (typed.kind === "over") {
      const bound = formatCount(typed.stated ?? typed.min, locale);
      return ar ? `أكثر من ${bound}$` : `over $${bound}`;
    }
    if (typed.kind === "under") {
      const bound = formatCount(typed.stated ?? typed.max, locale);
      return ar ? `أقل من ${bound}$` : `under $${bound}`;
    }
    if (typed.min === typed.max) return `${formatCount(typed.max, locale)}$`;
    return isolateLtr(`${formatCount(typed.min, locale)}-${formatCount(typed.max, locale)}$`, locale);
  }
  if (isBudgetBand(answers.budget)) return optionLabel("BUDGET", answers.budget, locale);
  return "";
}

/** Canonical budget text for records and alerts (`200-500`, `350`, or the band's range). */
export function budgetRecordText(answers: ServiceRequestAnswers): string {
  const typed = typedBudget(answers);
  if (typed) return typed.range;
  switch (answers.budget) {
    case "under_200":
      return "<200";
    case "200_500":
      return "200-500";
    case "500_1500":
      return "500-1500";
    case "over_1500":
      return ">1500";
    default:
      return "";
  }
}

export function platformsForAnswers(answers: ServiceRequestAnswers): PlatformScope {
  return calculateServiceEstimate(requestPricingInput(answers)).platforms;
}

/* -------------------------------------------------------------- messages ---- */

export const SERVICE_REQUEST_WELCOME: Record<Locale, string> = {
  ar: "أهلاً بك في أفق 👋\nأنا مساعد أفق، راح أساعدك تجهّز طلبك بأربع أسئلة سريعة.\n\nأول شي: شنو نوع الخدمة اللي تحتاجها؟ (تصميم / إعلانات / سوشيال ميديا / محتوى / SEO / غير ذلك)",
  en: "Welcome to Ofoq 👋\nI'm the Ofoq assistant, and I'll set up your request with four quick questions.\n\nFirst: what type of service do you need? (Design / Ads / Social media / Content / SEO / Other)",
};

export function contactChannelLines(locale: Locale, email?: string | null): string[] {
  const address = email?.trim() || (locale === "ar" ? "البريد المسجّل بحسابك" : "the address registered to your account");
  return locale === "ar"
    ? ["كيف تحب يتواصل معك فريق أفق؟", "□ 📱 واتساب", `□ 📧 إيميل: ${address}`, "□ 💬 إشعار في الموقع"]
    : ["How would you like the Ofoq team to contact you?", "□ 📱 WhatsApp", `□ 📧 Email: ${address}`, "□ 💬 In-app notification"];
}

/** The summary shown right after the four basic questions. */
export function serviceRequestSummary(
  answers: ServiceRequestAnswers,
  locale: Locale,
  options: { revised?: boolean } = {},
): string {
  const ar = locale === "ar";
  const lines = [
    options.revised
      ? ar
        ? `تمام، حدّثت الميزانية إلى ${budgetDisplayText(answers, locale)} ✅ وهذا طلبك بعد التعديل:`
        : `Done, I updated the budget to ${budgetDisplayText(answers, locale)} ✅ here is your revised request:`
      : ar
        ? "تمام، فهمت طلبك 👌"
        : "Great, I've got your request 👌",
    "",
    `${ar ? "- الخدمة" : "- Service"}: ${optionLabel("TYPE", answers.type, locale)}`,
    `${ar ? "- الحجم" : "- Size"}: ${optionLabel("SIZE", answers.size, locale)}`,
    `${ar ? "- الميزانية" : "- Budget"}: ${budgetDisplayText(answers, locale)}`,
    `${ar ? "- المنطقة المستهدفة" : "- Target area"}: ${optionLabel("TARGETING", answers.targeting, locale)}`,
    "",
    options.revised
      ? ar
        ? "خليني أعيد حساب التقدير على الميزانية الجديدة..."
        : "Let me recalculate the estimate for the new budget..."
      : ar
        ? "خليني أحسب لك تقديراً واضحاً..."
        : "Let me prepare a clear estimate...",
  ];
  return lines.join("\n");
}

/** Acknowledges a budget change made before the targeting question was answered. */
export function budgetUpdatedMessage(answers: ServiceRequestAnswers, locale: Locale): string {
  return locale === "ar"
    ? `تمام، حدّثت الميزانية إلى ${budgetDisplayText(answers, locale)} ✅`
    : `Done, I updated the budget to ${budgetDisplayText(answers, locale)} ✅`;
}

/**
 * The pricing message. Ads requests show the budget, the active ad days and the
 * expected results (smallest value first); other services show the official
 * price range only — impressions are never shown for them. Both end with the
 * contact-channel question.
 */
export function serviceRequestEstimate(
  answers: ServiceRequestAnswers,
  locale: Locale,
  options: { email?: string | null } = {},
): string {
  const ar = locale === "ar";
  const result = calculateServiceEstimate(requestPricingInput(answers));
  const contact = contactChannelLines(locale, options.email);

  if (result.service === "ads" && result.resultsKind === "numbers") {
    const reach = result.expectedReach ?? [0, 0];
    const visits = result.expectedVisits ?? [0, 0];
    const leads = result.expectedLeads ?? [0, 0];
    const typed = typedBudget(answers);
    const plansOn = `${formatCount(result.budgetAmount, locale)}$`;
    // The budget line always shows the budget the client gave — the pressed
    // button's own label, or the range / open amount they typed — and never the
    // planning amount standing in for it («ميزانيتك: 500$» for «200-500$» was
    // exactly that bug). The planning amount is stated separately whenever the
    // budget is not a single value.
    const display = budgetDisplayText(answers, locale) || plansOn;
    const showsPlan = typed ? typed.kind !== "single" : true;
    const budgetLine = `${ar ? "ميزانيتك" : "Your budget"}: ${display} ${result.budgetEmoji}${
      showsPlan ? (ar ? ` (التقدير محسوب على ${plansOn})` : ` (estimate based on ${plansOn})`) : ""
    }`;
    return [
      budgetLine,
      "",
      `💡 ${ar ? "تغطي" : "Covers"} ${result.estimatedAdDays} ${ar ? "يوم إعلان فعّال" : "active ad days"}`,
      "",
      ar ? "📊 النتائج المتوقعة:" : "📊 Expected results:",
      ar ? `• الظهور: ${formatCountRange(reach, locale)}` : `• Impressions: ${formatCountRange(reach, locale)}`,
      ar ? `• الزيارات: ${formatCountRange(visits, locale)}` : `• Visits: ${formatCountRange(visits, locale)}`,
      ar ? `• المهتمون: ${formatCountRange(leads, locale)}` : `• Interested people: ${formatCountRange(leads, locale)}`,
      "",
      ...contact,
    ].join("\n");
  }

  if (result.minPrice === null || result.maxPrice === null) {
    return [
      ar
        ? "ما عندنا نطاق سعر معتمد لهذا النوع، وما راح نخمن رقماً. يحتاج الطلب مراجعة تفاصيله قبل تحديد السعر."
        : "We do not have an approved price range for this request, so we will not guess. The scope needs review before a price can be set.",
      "",
      ...contact,
    ].join("\n");
  }

  const priceRange = formatUsdRange(result.minPrice, result.maxPrice, locale);
  return [
    `${ar ? "السعر التقديري" : "Estimated price"}: ${priceRange}`,
    "",
    ...contact,
  ].join("\n");
}

/** Shown when neither the local matcher nor the AI could name a real option. */
export function serviceRequestClarification(step: ServiceRequestQuestionStep, locale: Locale): string {
  const question = SERVICE_REQUEST_QUESTIONS[step];
  const options = question.options.map((option) => (locale === "ar" ? option.labelAr : option.labelEn)).join(" / ");
  return locale === "ar"
    ? `ما قدرت أحدد الخيار 🤔 اختر واحداً من الخيارات المتاحة:\n${options}`
    : `I could not match that to an option 🤔 please pick one of these:\n${options}`;
}

export function whatsappNumberPrompt(locale: Locale): string {
  return locale === "ar"
    ? "ابعث لي رقم واتساب الخاص بك حتى يتواصل معك فريق أفق (يبدأ بـ 07 أو +964)."
    : "Send me your WhatsApp number so the Ofoq team can reach you (starting with 07 or +964).";
}

/** What the server did with the completed request, as the confirmation shows it. */
export interface ServiceRequestSubmissionStatus {
  status: "pending" | "saved" | "failed";
  /** The order reference issued by the database once the request is saved. */
  orderCode?: string | null;
  /** Clear reason shown to the client when saving failed. */
  error?: string | null;
}

export const SERVICE_REQUEST_SAVE_FAILED: Record<Locale, string> = {
  ar: "تعذر حفظ طلبك ❌",
  en: "Your request could not be saved ❌",
};

/**
 * Confirmation of the chosen channel. The order reference is the one the
 * database issued; while the save is in flight the client sees that it is in
 * progress, and a failure is stated plainly (never a silent success).
 */
export function serviceRequestConfirmation(
  answers: ServiceRequestAnswers,
  locale: Locale,
  options: { email?: string | null; submission?: ServiceRequestSubmissionStatus | null } = {},
): string {
  const ar = locale === "ar";
  const submission: ServiceRequestSubmissionStatus = options.submission ?? { status: "pending" };
  const address = options.email?.trim() || (ar ? "البريد المسجّل بحسابك" : "the address registered to your account");

  const statusLines: string[] =
    submission.status === "saved"
      ? [`${ar ? "رقم الطلب" : "Order reference"}: ${submission.orderCode?.trim() || SERVICE_REQUEST_ORDER_CODE}`]
      : submission.status === "failed"
        ? [
            SERVICE_REQUEST_SAVE_FAILED[locale],
            ...(submission.error?.trim() ? [submission.error.trim()] : []),
            ar
              ? "اضغط «إعادة المحاولة» أو تواصل معنا مباشرة، ولا تحتاج تعيد الإجابات."
              : "Press “Try again” or contact us directly; you do not need to answer again.",
          ]
        : [ar ? "⏳ جارٍ حفظ طلبك وإصدار رقم الطلب…" : "⏳ Saving your request and issuing the order reference…"];

  const saved = submission.status !== "failed";
  if (answers.contact === "whatsapp") {
    return [
      saved ? (ar ? "تم حفظ رقمك ✅" : "Your number was saved ✅") : ar ? "استلمت رقمك" : "I have your number",
      ar ? `سيتواصل معك فريق أفق عبر واتساب على الرقم: ${answers.phone ?? ""}` : `The Ofoq team will contact you on WhatsApp at: ${answers.phone ?? ""}`,
      "",
      ...statusLines,
    ].join("\n");
  }

  if (answers.contact === "website") {
    return [
      saved ? (ar ? "تم حفظ طلبك ✅" : "Your request was saved ✅") : ar ? "استلمت طلبك" : "I have your request",
      ar ? "ستستلم إشعاراً في الموقع عند التواصل معك." : "You will receive an in-app notification when we reach out.",
      "",
      ...statusLines,
    ].join("\n");
  }

  return [
    saved ? (ar ? "تم حفظ طلبك ✅" : "Your request was saved ✅") : ar ? "استلمت طلبك" : "I have your request",
    ar ? `سيتواصل معك فريق أفق على البريد المسجل: ${address}` : `The Ofoq team will contact you at the registered address: ${address}`,
    "",
    ...statusLines,
  ].join("\n");
}

/** A one-line, human-readable summary of the request (alerts, emails, records). */
export function serviceRequestOneLineSummary(answers: ServiceRequestAnswers, locale: Locale): string {
  const result = calculateServiceEstimate(requestPricingInput(answers));
  const ar = locale === "ar";
  const budget = budgetDisplayText(answers, locale) || `${formatCount(result.budgetAmount, locale)}$`;
  const price =
    result.minPrice === null || result.maxPrice === null
      ? ar
        ? "السعر: يحتاج مراجعة"
        : "Price: needs review"
      : `${ar ? "السعر" : "Price"}: ${isolateLtr(
          `${formatCount(Math.min(result.minPrice, result.maxPrice), locale)}-${formatCount(Math.max(result.minPrice, result.maxPrice), locale)}$`,
          locale,
        )}`;
  return [
    `${ar ? "الخدمة" : "Service"}: ${optionLabel("TYPE", answers.type, locale)}`,
    `${ar ? "الحجم" : "Size"}: ${optionLabel("SIZE", answers.size, locale)}`,
    `${ar ? "الميزانية" : "Budget"}: ${budget}`,
    `${ar ? "المنطقة" : "Target area"}: ${optionLabel("TARGETING", answers.targeting, locale)}`,
    price,
  ].join(" • ");
}

/** Active ad days for the chosen budget (used in the pricing message). */
export function requestedAdDays(answers: ServiceRequestAnswers): number | null {
  const result = calculateServiceEstimate(requestPricingInput(answers));
  return result.resultsKind === "numbers" ? adDaysForBudget(result.budgetAmount) : null;
}
