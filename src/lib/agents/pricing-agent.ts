/**
 * وكيل التسعير — سياسة الإطلاق «أول 10 زبائن» + تقييم الميزانية والنتائج المتوقعة.
 * Launch pricing agent — the deterministic policy behind the guided «طلب خدمة»
 * conversation: founding-client prices, the budget read and the planning
 * estimates the client sees.
 *
 * Relationship to the rest of the codebase:
 *   * `src/lib/agents/specialists/pricing.agent.ts` prices the *catalogue*
 *     (services, quantities, discounts, margins) and records an auditable agent
 *     run in the database.
 *   * this module is the *launch sales policy*: a fixed table of starting
 *     prices, the founding-client discount, the budget evaluation and the
 *     expected-results ranges. It is pure — no database, no model call, no
 *     clock — so the same answers always produce the same numbers, and the
 *     landing chat can render it in the browser.
 *
 * Guarantees this file enforces by construction:
 *   1. Nobody is refused: every combination of answers returns a price.
 *   2. The agency fee and the ad-spend split live in `_internal` only. The UI
 *      renders `ClientPricingView` (see `toClientPricingView`), which has no
 *      field that could carry them — the fees can never leak by accident.
 *   3. Services that are not ads never receive invented performance numbers;
 *      they get a qualitative description instead.
 */
import type { Locale } from "@/lib/domain/types";

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export type PricingServiceType = "design" | "ads" | "social" | "content" | "seo" | "other";
export type ProjectSize = "small" | "medium" | "large";
export type PlatformScope = "single" | "multiple";
export type DeadlineSpeed = "urgent" | "normal" | "flexible";
export type BudgetBand = "under_200" | "200_500" | "500_1500" | "over_1500";
export type PricingTier = "founding" | "normal";
export type BudgetQuality = "weak" | "medium" | "good" | "excellent";

export interface PricingInput {
  type: PricingServiceType;
  size: ProjectSize;
  platforms: PlatformScope;
  deadline: DeadlineSpeed;
  budget: BudgetBand;
  /** How many clients the agency has counted, including this one. */
  customerCount: number;
}

export interface PricingResult {
  /** What was priced (kept on the result so the UI can describe it). */
  service: PricingServiceType;
  budgetBand: BudgetBand;

  // التقييم للعميل (بدون كشف داخلي):
  budgetQuality: BudgetQuality;
  budgetLabel: string; // "ضعيفة" / "متوسطة" / "جيدة" / "ممتازة"
  budgetLabelEn: string; // "Tight" / "Moderate" / "Good" / "Excellent"
  budgetEmoji: string; // 🟡 / 🟢 / 🟢🟢 / 🟢🟢🟢

  // الأسعار (للعميل):
  minPrice: number;
  maxPrice: number;
  midPrice: number;

  // توقعات النتائج. للإعلانات فقط أرقام؛ لغيرها [0, 0] مع وصف نوعي.
  expectedReach: [number, number]; // مدى الظهور
  expectedVisits: [number, number]; // مدى الزيارات
  expectedLeads: [number, number]; // مدى الـ leads
  resultsKind: "numbers" | "qualitative";
  qualitativeAr: string | null;
  qualitativeEn: string | null;

  // اقتراحات لو الميزانية ضعيفة:
  suggestions: string[];
  suggestionsEn: string[];

  // داخلي (ما يُعرض للعميل):
  _internal: {
    pricingTier: PricingTier;
    agencyFee: number;
    adSpend: number;
  };
}

/* -------------------------------------------------------------------------- */
/* Policy tables                                                              */
/* -------------------------------------------------------------------------- */

/** The launch offer applies to this many clients; from the 10th the prices are normal. */
export const FOUNDING_CLIENTS_TARGET = 10;

/**
 * How many clients the agency has signed so far.
 *
 * `calculateServiceEstimate` always takes the count as an argument, so the
 * platform can pass the live number from the database the day it exposes it
 * (the browser does not know it yet). Until then this constant is the single
 * place to bump when a client signs.
 */
export const CLIENTS_COUNTED_SO_FAR = 0;

export interface PriceRange {
  min: number;
  max: number;
}

/** جدول الأسعار — founding (أول 10 زبائن) */
export const FOUNDING_TIER_PRICES: Record<PricingServiceType, PriceRange> = {
  design: { min: 300, max: 700 },
  ads: { min: 200, max: 800 },
  social: { min: 180, max: 500 },
  content: { min: 150, max: 400 },
  seo: { min: 250, max: 700 },
  other: { min: 200, max: 500 },
};

/** جدول الأسعار — normal (بعد 10 زبائن) */
export const NORMAL_TIER_PRICES: Record<PricingServiceType, PriceRange> = {
  design: { min: 500, max: 1200 },
  ads: { min: 300, max: 1500 },
  social: { min: 300, max: 800 },
  content: { min: 250, max: 600 },
  seo: { min: 400, max: 1000 },
  other: { min: 300, max: 700 },
};

export interface TierMultipliers {
  size: Record<ProjectSize, number>;
  platforms: Record<PlatformScope, number>;
  deadline: Record<DeadlineSpeed, number>;
}

/** المضاعفات */
export const TIER_MULTIPLIERS: Record<PricingTier, TierMultipliers> = {
  founding: {
    size: { small: 0.7, medium: 1, large: 1.3 },
    platforms: { single: 1, multiple: 1.2 },
    deadline: { urgent: 1.25, normal: 1, flexible: 0.9 },
  },
  normal: {
    size: { small: 0.8, medium: 1, large: 1.5 },
    platforms: { single: 1, multiple: 1.3 },
    deadline: { urgent: 1.4, normal: 1, flexible: 0.9 },
  },
};

/**
 * نصيب الوكالة من السعر المتفق عليه — داخلي بالكامل ولا يُعرض للعميل أبدًا.
 * Share of the agreed price that stays with the agency. Internal only: it is
 * used for the platform's own accounting, never in client-facing text.
 */
export const AGENCY_FEE_PERCENT: Record<PricingTier, number> = { founding: 0.2, normal: 0.25 };

export interface BudgetBandInfo {
  /**
   * Used to classify the band. `over_1500` is open-ended, so 99,999 is a
   * sentinel ("more than 1,500"), not money.
   */
  ceiling: number;
  /**
   * The spend the ad projections are built on. For the open-ended band the
   * floor is used, because projecting 99,999 would invent a budget the client
   * never stated; the real number is agreed later with the client.
   */
  projectionSpend: number;
  quality: BudgetQuality;
  emoji: string;
  labelAr: string;
  labelEn: string;
}

export const BUDGET_BANDS: Record<BudgetBand, BudgetBandInfo> = {
  under_200: {
    ceiling: 200,
    projectionSpend: 200,
    quality: "weak",
    emoji: "🟡",
    labelAr: "ضعيفة",
    labelEn: "Tight",
  },
  "200_500": {
    ceiling: 500,
    projectionSpend: 500,
    quality: "medium",
    emoji: "🟢",
    labelAr: "متوسطة",
    labelEn: "Moderate",
  },
  "500_1500": {
    ceiling: 1500,
    projectionSpend: 1500,
    quality: "good",
    emoji: "🟢🟢",
    labelAr: "جيدة",
    labelEn: "Good",
  },
  over_1500: {
    ceiling: 99_999,
    projectionSpend: 1500,
    quality: "excellent",
    emoji: "🟢🟢🟢",
    labelAr: "ممتازة",
    labelEn: "Excellent",
  },
};

/**
 * Planning assumptions for ad projections — averages, not promises.
 * CPM ≈ 3$ per 1,000 impressions, CTR ≈ 2% (impression → visit),
 * conversion ≈ 3% (visit → lead). Every client-facing number built from these
 * is a range, and the chat says plainly that it is an estimate.
 */
export const ADS_PLANNING_ASSUMPTIONS = {
  cpm: 3,
  clickRate: 0.02,
  conversionRate: 0.03,
  spreadLow: 0.7,
  spreadHigh: 1.3,
} as const;

/** اقتراحات لو الميزانية ضعيفة. */
export const WEAK_BUDGET_SUGGESTIONS = {
  ar: [
    "نبدأ بمنصة وحدة (Instagram مثلاً) ونوسع لاحقاً",
    "نخلي التسليم عادي بدل مستعجل",
    "نبدأ بخدمة أصغر (تصميم شعار فقط مثلاً)",
  ],
  en: [
    "We start with one platform (Instagram, for example) and expand later",
    "We keep delivery standard instead of urgent",
    "We start with a smaller service (a logo design only, for example)",
  ],
} as const;

/**
 * الوصف النوعي لغير الإعلانات: ما نعرض أرقام لم نخترعها.
 * What a non-ad service is expected to do, in qualitative terms. No numbers:
 * a design or a content plan has no honest impression estimate to publish.
 */
const QUALITATIVE_RESULTS: Record<Exclude<PricingServiceType, "ads">, { ar: string; en: string }> = {
  design: {
    ar: "تصاميم بهوية واحدة: شكل ثابت لحسابك يوضّح عرضك من أول نظرة ويزيد ثقة الزائر.",
    en: "Designs under one identity: a consistent look that shows your offer at first glance and builds trust.",
  },
  social: {
    ar: "حضور منتظم وردود سريعة: تفاعل ثابت مع متابعينك ووصول طبيعي ينمو تدريجياً.",
    en: "A steady presence and fast replies: consistent engagement and organic reach that grows gradually.",
  },
  content: {
    ar: "محتوى بلغة عميلك: يشرح عرضك ويجاوب أسئلته قبل ما يسألها.",
    en: "Content in your client's language: explains your offer and answers the questions before they are asked.",
  },
  seo: {
    ar: "تحسين صفحاتك وبنيتها: أساس تقني ومحتوى يستهدف الكلمات اللي يبحث بها عميلك.",
    en: "Improving your pages and their structure: a technical base and content aimed at what your client searches for.",
  },
  other: {
    ar: "خطة مكتوبة قبل التنفيذ: نحدد الخطوات والنتيجة المتوقعة ونتفق عليها أولاً.",
    en: "A written plan before delivery: we agree the steps and the expected outcome first.",
  },
};

/* -------------------------------------------------------------------------- */
/* Calculation                                                                */
/* -------------------------------------------------------------------------- */

/** Pricing tier from the number of clients: the first 10 are founding clients. */
export function pricingTierFor(customerCount: number): PricingTier {
  return customerCount < FOUNDING_CLIENTS_TARGET ? "founding" : "normal";
}

/** Whole dollars: the tables are in dollars and the client sees whole numbers. */
function roundDollars(value: number): number {
  return Math.round(value);
}

function spread(value: number, step: number): [number, number] {
  const round = (input: number) => Math.max(0, Math.round(input / step) * step);
  return [
    round(value * ADS_PLANNING_ASSUMPTIONS.spreadLow),
    round(value * ADS_PLANNING_ASSUMPTIONS.spreadHigh),
  ];
}

/**
 * تقديرات الإعلانات: reach → visits → leads، على أساس افتراضات التخطيط أعلاه.
 * Ad projections are the only place where numbers are shown, because they are
 * the only ones with a defensible basis (a spend, a CPM and two rates).
 */
function adsProjections(spend: number): Pick<PricingResult, "expectedReach" | "expectedVisits" | "expectedLeads"> {
  const reach = (spend / ADS_PLANNING_ASSUMPTIONS.cpm) * 1000;
  const visits = reach * ADS_PLANNING_ASSUMPTIONS.clickRate;
  const leads = visits * ADS_PLANNING_ASSUMPTIONS.conversionRate;
  return {
    expectedReach: spread(reach, 100),
    expectedVisits: spread(visits, 10),
    expectedLeads: spread(leads, 1),
  };
}

/**
 * تسعير الطلب + تقييم الميزانية + النتائج المتوقعة.
 * Deterministic: same input → same output. Never throws for a valid input and
 * never refuses a client (see `PricingInput`).
 */
export function calculateServiceEstimate(input: PricingInput): PricingResult {
  const pricingTier = pricingTierFor(input.customerCount);
  const base = (pricingTier === "founding" ? FOUNDING_TIER_PRICES : NORMAL_TIER_PRICES)[input.type];
  const multipliers = TIER_MULTIPLIERS[pricingTier];
  const multiplier = multipliers.size[input.size] * multipliers.platforms[input.platforms] * multipliers.deadline[input.deadline];

  const minPrice = roundDollars(base.min * multiplier);
  const maxPrice = roundDollars(base.max * multiplier);
  const midPrice = roundDollars((minPrice + maxPrice) / 2);

  // التفصيل الداخلي: ما يظهر للعميل أبدًا. النسبة واحدة للإعلانات ولغيرها،
  // ومكانها هنا وحيد حتى لا تتفرع الحسابات.
  const agencyFee = roundDollars(midPrice * AGENCY_FEE_PERCENT[pricingTier]);
  const adSpend = input.type === "ads" ? midPrice - agencyFee : 0;

  const band = BUDGET_BANDS[input.budget];
  const isAds = input.type === "ads";
  const projections = isAds
    ? adsProjections(band.projectionSpend)
    : { expectedReach: [0, 0] as [number, number], expectedVisits: [0, 0] as [number, number], expectedLeads: [0, 0] as [number, number] };
  const qualitative = input.type === "ads" ? null : QUALITATIVE_RESULTS[input.type];
  const weak = band.quality === "weak";

  return {
    service: input.type,
    budgetBand: input.budget,

    budgetQuality: band.quality,
    budgetLabel: band.labelAr,
    budgetLabelEn: band.labelEn,
    budgetEmoji: band.emoji,

    minPrice,
    maxPrice,
    midPrice,

    ...projections,
    resultsKind: isAds ? "numbers" : "qualitative",
    qualitativeAr: qualitative?.ar ?? null,
    qualitativeEn: qualitative?.en ?? null,

    suggestions: weak ? [...WEAK_BUDGET_SUGGESTIONS.ar] : [],
    suggestionsEn: weak ? [...WEAK_BUDGET_SUGGESTIONS.en] : [],

    _internal: { pricingTier, agencyFee, adSpend },
  };
}

/* -------------------------------------------------------------------------- */
/* Client-facing projection                                                   */
/* -------------------------------------------------------------------------- */

/**
 * كل ما يُسمح بعرضه للعميل — لا حقل للأتعاب أو توزيع الميزانية.
 * The only shape the UI may render. It is built field by field from public
 * values, so `_internal` cannot travel with it: showing the agency fee or the
 * ad-spend split requires editing this type on purpose.
 */
export interface ClientPricingView {
  service: PricingServiceType;
  budgetQuality: BudgetQuality;
  budgetLabel: string;
  budgetEmoji: string;
  minPrice: number;
  maxPrice: number;
  midPrice: number;
  results:
    | { kind: "numbers"; reach: [number, number]; visits: [number, number]; leads: [number, number] }
    | { kind: "qualitative"; text: string };
  /** Empty unless the budget is weak. */
  suggestions: string[];
}

export function toClientPricingView(result: PricingResult, locale: Locale): ClientPricingView {
  const isAr = locale === "ar";
  return {
    service: result.service,
    budgetQuality: result.budgetQuality,
    budgetLabel: isAr ? result.budgetLabel : result.budgetLabelEn,
    budgetEmoji: result.budgetEmoji,
    minPrice: result.minPrice,
    maxPrice: result.maxPrice,
    midPrice: result.midPrice,
    results:
      result.resultsKind === "numbers"
        ? {
            kind: "numbers",
            reach: result.expectedReach,
            visits: result.expectedVisits,
            leads: result.expectedLeads,
          }
        : { kind: "qualitative", text: (isAr ? result.qualitativeAr : result.qualitativeEn) ?? "" },
    suggestions: isAr ? result.suggestions : result.suggestionsEn,
  };
}

/** كل الأسعار بالدولار، بأرقام لاتينية في الواجهتين العربية والإنجليزية. */
export function formatUsd(amount: number, locale: Locale): string {
  const formatted = new Intl.NumberFormat(locale === "ar" ? "ar-IQ-u-nu-latn" : "en-GB", {
    maximumFractionDigits: 0,
  }).format(amount);
  return `${formatted}$`;
}

function formatCount(amount: number, locale: Locale): string {
  return new Intl.NumberFormat(locale === "ar" ? "ar-IQ-u-nu-latn" : "en-GB", {
    maximumFractionDigits: 0,
  }).format(amount);
}

/* -------------------------------------------------------------------------- */
/* Client-facing wording                                                      */
/* -------------------------------------------------------------------------- */

/**
 * نص التقدير كما يراه العميل بعد الأسئلة: السعر التقديري، تقييم الميزانية،
 * النتائج المتوقعة، ثم اقتراحات عند ضعف الميزانية.
 *
 * It is written from `ClientPricingView` alone — the agency fee and the ad-spend
 * split (`_internal`) have no path into this text, which is why the wording
 * lives next to the numbers instead of in the view layer.
 */
export function describeClientEstimate(result: PricingResult, locale: Locale): string {
  const ar = locale === "ar";
  const view = toClientPricingView(result, locale);
  const range = ([low, high]: [number, number]) => `${formatCount(low, locale)} – ${formatCount(high, locale)}`;
  const lines: string[] = [];

  lines.push(ar ? "حسبت لك تقدير مبدئي على أساس إجاباتك:" : "Here is a first estimate based on your answers:");
  lines.push("");
  lines.push(ar
    ? `💰 السعر التقديري: ${formatUsd(view.minPrice, locale)} – ${formatUsd(view.maxPrice, locale)}`
    : `💰 Estimated price: ${formatUsd(view.minPrice, locale)} – ${formatUsd(view.maxPrice, locale)}`);
  lines.push(ar
    ? `🎯 الأنسب لمشروعك: ${formatUsd(view.midPrice, locale)}`
    : `🎯 Best fit for your project: ${formatUsd(view.midPrice, locale)}`);
  lines.push(ar
    ? `📊 تقييم الميزانية: ${view.budgetEmoji} ${view.budgetLabel}`
    : `📊 Budget read: ${view.budgetEmoji} ${view.budgetLabel}`);
  lines.push("");

  if (view.results.kind === "numbers") {
    lines.push(ar ? "📈 النتائج المتوقعة شهرياً (تقدير):" : "📈 Expected results per month (estimate):");
    lines.push(ar ? `• الظهور: ${range(view.results.reach)}` : `• Impressions: ${range(view.results.reach)}`);
    lines.push(ar ? `• الزيارات: ${range(view.results.visits)}` : `• Visits: ${range(view.results.visits)}`);
    lines.push(ar ? `• العملاء المحتملون: ${range(view.results.leads)}` : `• Leads: ${range(view.results.leads)}`);
  } else {
    lines.push(ar ? "✨ ما تحصل عليه:" : "✨ What you get:");
    lines.push(view.results.text);
  }

  if (view.suggestions.length > 0) {
    lines.push("");
    lines.push(ar ? "💡 نبدأ بهاي الطريقة لتناسب ميزانيتك:" : "💡 To fit your budget we start like this:");
    for (const suggestion of view.suggestions) lines.push(`• ${suggestion}`);
    lines.push(ar
      ? "ما نرفض أي طلب: نبدأ بالخطوة الأصغر ونتوسع لاحقاً."
      : "We do not turn requests down: we start with the smaller step and expand later.");
  }

  lines.push("");
  lines.push(ar
    ? "الأرقام تقديرية للتخطيط، وتُثبَّت في العرض الرسمي قبل أي دفعة."
    : "These are planning estimates; the official offer fixes them before any payment.");
  if (view.results.kind === "numbers") {
    lines.push(ar
      ? "بنيناها على متوسطات السوق (تكلفة الظهور، نسبة النقر، نسبة التحويل) — مو وعد بنتيجة."
      : "They use market averages (cost of impressions, click rate, conversion rate) — not a promise of results.");
  }
  lines.push(ar
    ? "إذا حبيت تكمل مع الفريق اكتب: «أريد التحدث مع شخص من الفريق»."
    : "To continue with the team, write: “I want to speak with a person from the team”.");

  return lines.join("\n");
}
