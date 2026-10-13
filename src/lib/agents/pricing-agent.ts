/**
 * Ofoq's client-facing pricing policy for the guided service request.
 *
 * This module is deliberately pure: it has no database or model dependency.
 * Fixed service ranges and the requested scope multipliers produce a quote.
 * Ad performance is a planning range based on the client's monthly budget and
 * selected market — never a promise or guaranteed result.
 *
 * The expected-results formulas (the ones the client sees) are:
 *
 *   effective_cpm    = 3 × cpm_multiplier
 *   effective_budget = budget × 0.8
 *   impressions      = (effective_budget / effective_cpm) × 1000 × reach_mult
 *   visits           = impressions × 0.01
 *   leads            = visits × 0.025
 *
 * and the published range is 70%–130% of the calculated value. Anchors used by
 * the tests and the support docs:
 *
 *   $200   →  37,000–69,000 impressions
 *   $500   →  92,000–172,000 impressions
 *   $1,000 → 185,000–345,000 impressions
 */
import type { Locale } from "@/lib/domain/types";

export type ProjectSize = "small" | "medium" | "large";
export type PlatformScope = "single" | "multiple";
export type BudgetBand = "under_200" | "200_500" | "500_1500" | "over_1500";
export type BudgetQuality = "weak" | "medium" | "good" | "excellent";

export interface PriceRange {
  min: number;
  max: number;
}

/** Official prices only; amounts are USD. */
export const SERVICES = {
  design: { min: 500, max: 1_200 },
  ads: { min: 300, max: 1_500 },
  social: { min: 300, max: 800 },
  content: { min: 250, max: 600 },
  seo: { min: 400, max: 1_000 },
} as const satisfies Record<string, PriceRange>;

export type PricedServiceType = keyof typeof SERVICES;
/** `other` stays available in the conversation, but has no published price. */
export type PricingServiceType = PricedServiceType | "other";

/**
 * Scope multipliers. Delivery time is not asked any more: every guided request
 * is planned as a normal (non-urgent) delivery. The number of platforms is not
 * asked either — `platformScopeForBudget()` derives it from the budget.
 */
export const PRICE_MULTIPLIERS = {
  size: { small: 0.8, medium: 1.0, large: 1.5 },
  platforms: { single: 1.0, multiple: 1.3 },
} as const;

export const TARGETING_FACTORS = {
  iraq_all: { reach: 1.0, cpm: 1.0 },
  baghdad: { reach: 0.35, cpm: 1.2 },
  basra: { reach: 0.12, cpm: 0.9 },
  three_cities: { reach: 0.55, cpm: 1.05 },
  gulf: { reach: 0.8, cpm: 4.0 },
  arabic_global: { reach: 1.5, cpm: 2.0 },
} as const;

export type TargetingArea = keyof typeof TARGETING_FACTORS;

export interface PricingInput {
  type: PricingServiceType;
  size: ProjectSize;
  budget: BudgetBand;
  targeting: TargetingArea;
  /**
   * Exact planning amount in USD when the client typed a value or a range
   * («من 200 إلى 500» → 500) instead of pressing a band button. Overrides the
   * band's published upper bound in every calculation; the band still decides
   * the quality label and emoji.
   */
  budgetAmount?: number | null;
}

export interface BudgetBandInfo {
  /** Planning value of this monthly band (its published upper bound). */
  max: number;
  quality: BudgetQuality;
  emoji: string;
  labelAr: string;
  labelEn: string;
}

export function classifyBudget(budgetMax: number): BudgetQuality {
  if (budgetMax <= 200) return "weak";
  if (budgetMax <= 500) return "medium";
  if (budgetMax <= 1_500) return "good";
  return "excellent";
}

export const BUDGET_BANDS: Record<BudgetBand, BudgetBandInfo> = {
  under_200: {
    max: 200,
    quality: classifyBudget(200),
    emoji: "🟡",
    labelAr: "ضعيفة",
    labelEn: "Weak",
  },
  "200_500": {
    max: 500,
    quality: classifyBudget(500),
    emoji: "🟢",
    labelAr: "متوسطة",
    labelEn: "Medium",
  },
  "500_1500": {
    max: 1_500,
    quality: classifyBudget(1_500),
    emoji: "🟢🟢",
    labelAr: "جيدة",
    labelEn: "Good",
  },
  over_1500: {
    max: 3_000,
    quality: classifyBudget(3_000),
    emoji: "🟢🟢🟢",
    labelAr: "ممتازة",
    labelEn: "Excellent",
  },
};

/**
 * Planning assumptions for paid ads.
 *
 *  - `effectiveSpendShare`: 80% of the stated budget reaches the ad platforms
 *    (the rest covers agency handling and platform rounding).
 *  - `deliveryEfficiency`: impressions are quoted at 99.5% delivery pacing, so
 *    the published range is the raw budget/CPM maths and not a cent more.
 *  - `spreadLow`/`spreadHigh`: the published uncertainty band (70%–130%).
 */
export const ADS_PLANNING_ASSUMPTIONS = {
  cpm: 3,
  clickRate: 0.01,
  conversionRate: 0.025,
  spreadLow: 0.7,
  spreadHigh: 1.3,
  effectiveSpendShare: 0.8,
  deliveryEfficiency: 0.995,
  dailySpendForDuration: 10,
} as const;

/** A `[min, max]` pair of whole counters, smallest first. */
export type CountRange = [number, number];

export interface AdPerformance {
  impressions: CountRange;
  visits: CountRange;
  leads: CountRange;
}

export interface PricingResult {
  service: PricingServiceType;
  budgetBand: BudgetBand;
  budgetAmount: number;
  budgetQuality: BudgetQuality;
  budgetLabel: string;
  budgetEmoji: string;
  /** Derived from the budget: one platform up to $200, several above it. */
  platforms: PlatformScope;
  /** `null` only for `other`, which has no official public price. */
  minPrice: number | null;
  maxPrice: number | null;
  midPrice: number | null;
  /** Non-ad services and an unpublished `other` request have no performance stats. */
  resultsKind: "numbers" | "none";
  expectedReach: CountRange | null;
  expectedVisits: CountRange | null;
  expectedLeads: CountRange | null;
  targeting: TargetingArea;
  /** Estimated active ad days, using 80% of the stated budget and a $10/day plan. */
  estimatedAdDays: number | null;
}

/**
 * The platform scope is inferred from the budget, never asked:
 * $200 or less runs on one platform, anything above it is planned across
 * several platforms (which is also what the price multiplier reflects).
 */
export function platformScopeForBudget(budgetAmount: number): PlatformScope {
  return budgetAmount <= 200 ? "single" : "multiple";
}

/** Active ad days for a budget, at 80% spend share and a $10/day plan (max a month). */
export function adDaysForBudget(budgetAmount: number): number {
  const days = Math.floor(
    (budgetAmount * ADS_PLANNING_ASSUMPTIONS.effectiveSpendShare) / ADS_PLANNING_ASSUMPTIONS.dailySpendForDuration,
  );
  return Math.max(1, Math.min(30, days));
}

function roundDollar(value: number): number {
  return Math.round(value);
}

function floorTo(value: number, step: number): number {
  return Math.max(0, Math.floor(value / step) * step);
}

function roundTo(value: number, step: number): number {
  return Math.max(0, Math.round(value / step) * step);
}

/**
 * The published range of a calculated value: 70%–130%, always smallest first.
 * The low end is floored and the high end rounded, so the range is never
 * narrower than the calculation it comes from.
 */
export function spreadRange(value: number, step: number): CountRange {
  return [
    floorTo(value * ADS_PLANNING_ASSUMPTIONS.spreadLow, step),
    roundTo(value * ADS_PLANNING_ASSUMPTIONS.spreadHigh, step),
  ];
}

/**
 * Expected ad performance for an exact monthly budget and target area.
 *
 * Exported so the numbers can be quoted (and verified) for any budget, e.g.
 * `estimateAdsPerformance(1_000, "iraq_all")` → 185,000–345,000 impressions.
 */
export function estimateAdsPerformance(budgetAmount: number, targeting: TargetingArea): AdPerformance {
  const target = TARGETING_FACTORS[targeting];
  const effectiveCpm = ADS_PLANNING_ASSUMPTIONS.cpm * target.cpm;
  const effectiveBudget = budgetAmount * ADS_PLANNING_ASSUMPTIONS.effectiveSpendShare;
  const impressions =
    (effectiveBudget / effectiveCpm) * 1_000 * target.reach * ADS_PLANNING_ASSUMPTIONS.deliveryEfficiency;
  const visits = impressions * ADS_PLANNING_ASSUMPTIONS.clickRate;
  const leads = visits * ADS_PLANNING_ASSUMPTIONS.conversionRate;

  return {
    impressions: spreadRange(impressions, 1_000),
    visits: spreadRange(visits, 10),
    leads: spreadRange(leads, 1),
  };
}

/** Deterministic quote and performance estimate. */
export function calculateServiceEstimate(input: PricingInput): PricingResult {
  const budget = BUDGET_BANDS[input.budget];
  const budgetAmount =
    typeof input.budgetAmount === "number" && Number.isFinite(input.budgetAmount) && input.budgetAmount > 0
      ? Math.round(input.budgetAmount)
      : budget.max;
  const price = input.type === "other" ? null : SERVICES[input.type];
  const platforms = platformScopeForBudget(budgetAmount);
  const multiplier = PRICE_MULTIPLIERS.size[input.size] * PRICE_MULTIPLIERS.platforms[platforms];
  const minPrice = price ? roundDollar(price.min * multiplier) : null;
  const maxPrice = price ? roundDollar(price.max * multiplier) : null;
  const midPrice = minPrice !== null && maxPrice !== null ? roundDollar((minPrice + maxPrice) / 2) : null;
  // Only paid ads have expected performance numbers.
  const hasAdResults = input.type === "ads";
  const performance = hasAdResults
    ? estimateAdsPerformance(budgetAmount, input.targeting)
    : { impressions: null, visits: null, leads: null };

  return {
    service: input.type,
    budgetBand: input.budget,
    budgetAmount,
    budgetQuality: budget.quality,
    budgetLabel: budget.labelAr,
    budgetEmoji: budget.emoji,
    platforms,
    minPrice,
    maxPrice,
    midPrice,
    resultsKind: hasAdResults ? "numbers" : "none",
    expectedReach: performance.impressions,
    expectedVisits: performance.visits,
    expectedLeads: performance.leads,
    targeting: input.targeting,
    estimatedAdDays: hasAdResults ? adDaysForBudget(budgetAmount) : null,
  };
}

/**
 * Bidi isolates (U+2066 / U+2069) around a Latin-digit run.
 *
 * An Arabic message is laid out right-to-left, and the Unicode bidi algorithm
 * treats the digits of a range as Arabic numbers once an Arabic letter precedes
 * them: the two ends are then reordered on screen, so «~92,000-172,000» — which
 * is built in the right order — is *displayed* as «~172,000-92,000» while the
 * saved text is correct. Isolating the run pins it to left-to-right order, so
 * what the client reads is exactly what was generated: smallest value first.
 *
 * English (LTR) text needs no isolation and is returned unchanged, which keeps
 * the stored English copy free of invisible characters.
 */
export const LTR_ISOLATE_START = "\u2066";
export const LTR_ISOLATE_END = "\u2069";

export function isolateLtr(text: string, locale: Locale): string {
  return locale === "ar" ? `${LTR_ISOLATE_START}${text}${LTR_ISOLATE_END}` : text;
}

/**
 * A `[min, max]` counter range as the client reads it: `~92,000-172,000`, the
 * smaller value always first (`1000-1500` never becomes `1500-1000`, whatever
 * order the pair arrives in), isolated for Arabic so the two ends cannot swap
 * places on screen.
 */
export function formatCountRange(range: CountRange, locale: Locale): string {
  const min = Math.min(range[0], range[1]);
  const max = Math.max(range[0], range[1]);
  return isolateLtr(`~${formatCount(min, locale)}-${formatCount(max, locale)}`, locale);
}

/** A USD range the same way: `~650-1,560$`, smaller value first. */
export function formatUsdRange(min: number, max: number, locale: Locale): string {
  const low = Math.min(min, max);
  const high = Math.max(min, max);
  return isolateLtr(`~${formatCount(low, locale)}-${formatCount(high, locale)}$`, locale);
}

/** Whole-dollar USD display, with Latin digits in Arabic UI as well. */
export function formatUsd(amount: number, locale: Locale): string {
  const formatted = new Intl.NumberFormat(locale === "ar" ? "ar-IQ-u-nu-latn" : "en-GB", {
    maximumFractionDigits: 0,
  }).format(amount);
  return `$${formatted}`;
}

export function formatCount(amount: number, locale: Locale): string {
  return new Intl.NumberFormat(locale === "ar" ? "ar-IQ-u-nu-latn" : "en-GB", {
    maximumFractionDigits: 0,
  }).format(amount);
}
