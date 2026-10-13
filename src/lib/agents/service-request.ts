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
  BUDGET_BANDS,
  adDaysForBudget,
  calculateServiceEstimate,
  formatCount,
  type BudgetBand,
  type PlatformScope,
  type PricingInput,
  type PricingServiceType,
  type ProjectSize,
  type TargetingArea,
} from "./pricing-agent";

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
export type ServiceRequestAnswerKey = "type" | "size" | "budget" | "targeting" | "contact" | "phone";
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

/** Order reference used while the Supabase binding is deferred (PR #2). */
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
): ServiceRequestState {
  const step = currentQuestionStep(state);
  if (!step) return state;
  const option = serviceRequestOption(step, optionId);
  if (!option) return state;

  const answers: ServiceRequestAnswers = { ...state.answers, [SERVICE_REQUEST_QUESTIONS[step].answerKey]: option.id };
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
  let state = createServiceRequestState();
  for (const event of log) {
    if (event.step === "PHONE") {
      const attempt = submitWhatsappNumber(state, answers.phone ?? "", event.answeredAt);
      if (attempt.error) return null;
      state = attempt.state;
      continue;
    }
    const question = SERVICE_REQUEST_QUESTIONS[event.step as ServiceRequestQuestionStep];
    if (!question || !event.optionId) return null;
    if (currentQuestionStep(state) !== event.step) return null;
    const before = state.step;
    state = answerServiceRequest(state, event.optionId, event.answeredAt);
    if (state.step === before) return null;
    if (state.answers[question.answerKey] !== event.optionId) return null;
  }
  return state;
}

/** True once a contact channel was chosen (and, for WhatsApp, the number saved). */
export function isServiceRequestSubmitted(answers: ServiceRequestAnswers): boolean {
  if (!answers.contact) return false;
  if (answers.contact === "whatsapp") return Boolean(answers.phone);
  return answers.contact === "email" || answers.contact === "website";
}

/** The pricing agent's input, built only from values the questions offered. */
export function requestPricingInput(answers: ServiceRequestAnswers): PricingInput {
  const budget: BudgetBand = isBudgetBand(answers.budget) ? answers.budget : "under_200";
  const targeting = SERVICE_REQUEST_QUESTIONS.TARGETING.options.some((option) => option.id === answers.targeting)
    ? (answers.targeting as TargetingArea)
    : "iraq_all";
  return {
    type: SERVICE_TYPE_BY_OPTION[answers.type ?? "other"] ?? "other",
    size: answers.size === "small" || answers.size === "large" ? answers.size : "medium",
    budget,
    targeting,
  };
}

function isBudgetBand(value: string | undefined): value is BudgetBand {
  return value === "under_200" || value === "200_500" || value === "500_1500" || value === "over_1500";
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
export function serviceRequestSummary(answers: ServiceRequestAnswers, locale: Locale): string {
  const ar = locale === "ar";
  const budget = isBudgetBand(answers.budget) ? BUDGET_BANDS[answers.budget].max : null;
  const lines = [
    ar ? "تمام، فهمت طلبك 👌" : "Great, I've got your request 👌",
    "",
    `${ar ? "- الخدمة" : "- Service"}: ${optionLabel("TYPE", answers.type, locale)}`,
    `${ar ? "- الحجم" : "- Size"}: ${optionLabel("SIZE", answers.size, locale)}`,
    `${ar ? "- الميزانية" : "- Budget"}: ${budget === null ? "" : `${formatCount(budget, locale)}$`}`,
    `${ar ? "- المنطقة المستهدفة" : "- Target area"}: ${optionLabel("TARGETING", answers.targeting, locale)}`,
    "",
    ar ? "خليني أحسب لك تقديراً واضحاً..." : "Let me prepare a clear estimate...",
  ];
  return lines.join("\n");
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
  const formatRange = ([min, max]: [number, number]) => `~${formatCount(min, locale)}-${formatCount(max, locale)}`;

  if (result.service === "ads" && result.resultsKind === "numbers") {
    const reach = result.expectedReach ?? [0, 0];
    const visits = result.expectedVisits ?? [0, 0];
    const leads = result.expectedLeads ?? [0, 0];
    return [
      `${ar ? "ميزانيتك" : "Your budget"}: ${formatCount(result.budgetAmount, locale)}$ ${result.budgetEmoji}`,
      "",
      `💡 ${ar ? "تغطي" : "Covers"} ${result.estimatedAdDays} ${ar ? "يوم إعلان فعّال" : "active ad days"}`,
      "",
      ar ? "📊 النتائج المتوقعة:" : "📊 Expected results:",
      ar ? `• الظهور: ${formatRange(reach)}` : `• Impressions: ${formatRange(reach)}`,
      ar ? `• الزيارات: ${formatRange(visits)}` : `• Visits: ${formatRange(visits)}`,
      ar ? `• المهتمون: ${formatRange(leads)}` : `• Interested people: ${formatRange(leads)}`,
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

  const priceRange = `~${formatCount(result.minPrice, locale)}-${formatCount(result.maxPrice, locale)}$`;
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

/** Confirmation of the chosen channel, with the temporary order reference. */
export function serviceRequestConfirmation(
  answers: ServiceRequestAnswers,
  locale: Locale,
  options: { email?: string | null } = {},
): string {
  const ar = locale === "ar";
  const order = `${ar ? "رقم الطلب" : "Order reference"}: ${SERVICE_REQUEST_ORDER_CODE}`;
  const address = options.email?.trim() || (ar ? "البريد المسجّل بحسابك" : "the address registered to your account");

  if (answers.contact === "whatsapp") {
    return [
      ar ? "تم حفظ رقمك ✅" : "Your number was saved ✅",
      ar ? `سيتواصل معك فريق أفق عبر واتساب على الرقم: ${answers.phone ?? ""}` : `The Ofoq team will contact you on WhatsApp at: ${answers.phone ?? ""}`,
      "",
      order,
    ].join("\n");
  }

  if (answers.contact === "website") {
    return [
      ar ? "تم حفظ طلبك ✅" : "Your request was saved ✅",
      ar ? "ستستلم إشعاراً في الموقع عند التواصل معك." : "You will receive an in-app notification when we reach out.",
      "",
      order,
    ].join("\n");
  }

  return [
    ar ? "تم حفظ طلبك ✅" : "Your request was saved ✅",
    ar ? `سيتواصل معك فريق أفق على البريد المسجل: ${address}` : `The Ofoq team will contact you at the registered address: ${address}`,
    "",
    order,
  ].join("\n");
}

/** A one-line, human-readable summary of the request (alerts, emails, records). */
export function serviceRequestOneLineSummary(answers: ServiceRequestAnswers, locale: Locale): string {
  const result = calculateServiceEstimate(requestPricingInput(answers));
  const ar = locale === "ar";
  const budget = `${formatCount(result.budgetAmount, locale)}$`;
  const price =
    result.minPrice === null || result.maxPrice === null
      ? ar
        ? "السعر: يحتاج مراجعة"
        : "Price: needs review"
      : `${ar ? "السعر" : "Price"}: ${formatCount(result.minPrice, locale)}-${formatCount(result.maxPrice, locale)}$`;
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
