/**
 * Ofoq's client-facing pricing policy for the guided service request.
 *
 * This module is deliberately pure: it has no database or model dependency.
 * Fixed service ranges and the requested scope multipliers produce a quote.
 * Ad performance is a conservative planning range based on the client's
 * monthly budget and selected market — never a promise or guaranteed result.
 */
import type { Locale } from "@/lib/domain/types";

export type ProjectSize = "small" | "medium" | "large";
export type PlatformScope = "single" | "multiple";
export type DeadlineSpeed = "urgent" | "normal" | "flexible";
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

export const PRICE_MULTIPLIERS = {
  size: { small: 0.8, medium: 1.0, large: 1.5 },
  platforms: { single: 1.0, multiple: 1.3 },
  deadline: { urgent: 1.4, normal: 1.0, flexible: 0.9 },
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
  platforms: PlatformScope;
  deadline: DeadlineSpeed;
  budget: BudgetBand;
  targeting: TargetingArea;
}

export interface BudgetBandInfo {
  /** Conservative planning value for the maximum of this monthly band. */
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
 * Planning assumptions. The additional conservative calibration is intentional:
 * applying the raw CPM calculation directly would overstate expected reach for
 * a small Iraqi-market budget. With the 70–130% uncertainty band, a $200 budget
 * targeting Iraq produces the conservative public example of 8,000–15,000 views.
 */
export const ADS_PLANNING_ASSUMPTIONS = {
  cpm: 3,
  clickRate: 0.01,
  conversionRate: 0.025,
  spreadLow: 0.7,
  spreadHigh: 1.3,
  effectiveSpendShare: 0.8,
  conservativeCalibration: 0.22,
  dailySpendForDuration: 10,
} as const;

export interface PricingResult {
  service: PricingServiceType;
  budgetBand: BudgetBand;
  budgetAmount: number;
  budgetQuality: BudgetQuality;
  budgetLabel: string;
  budgetEmoji: string;
  /** `null` only for `other`, which has no official public price. */
  minPrice: number | null;
  maxPrice: number | null;
  midPrice: number | null;
  /** Non-ad services and an unpublished `other` request have no performance stats. */
  resultsKind: "numbers" | "none";
  expectedReach: [number, number] | null;
  expectedVisits: [number, number] | null;
  expectedLeads: [number, number] | null;
  targeting: TargetingArea;
  /** Estimated active ad days, using 80% of the stated budget and a $10/day plan. */
  estimatedAdDays: number | null;
}

function roundDollar(value: number): number {
  return Math.round(value);
}

function roundRange(value: number, step: number): [number, number] {
  const round = (amount: number) => Math.max(0, Math.round(amount / step) * step);
  return [
    round(value * ADS_PLANNING_ASSUMPTIONS.spreadLow),
    round(value * ADS_PLANNING_ASSUMPTIONS.spreadHigh),
  ];
}

function adsProjections(budget: number, targeting: TargetingArea): Pick<PricingResult, "expectedReach" | "expectedVisits" | "expectedLeads"> {
  const target = TARGETING_FACTORS[targeting];
  const effectiveCpm = ADS_PLANNING_ASSUMPTIONS.cpm * target.cpm;
  const effectiveAdSpend = budget * ADS_PLANNING_ASSUMPTIONS.effectiveSpendShare;
  const conservativeSpend = effectiveAdSpend * ADS_PLANNING_ASSUMPTIONS.conservativeCalibration;
  const impressions = (conservativeSpend / effectiveCpm) * 1_000 * target.reach;
  const visits = impressions * ADS_PLANNING_ASSUMPTIONS.clickRate;
  const leads = visits * ADS_PLANNING_ASSUMPTIONS.conversionRate;

  return {
    expectedReach: roundRange(impressions, 1_000),
    expectedVisits: roundRange(visits, 10),
    expectedLeads: roundRange(leads, 1),
  };
}

/** Deterministic quote and performance estimate. */
export function calculateServiceEstimate(input: PricingInput): PricingResult {
  const budget = BUDGET_BANDS[input.budget];
  const price = input.type === "other" ? null : SERVICES[input.type];
  const multiplier =
    PRICE_MULTIPLIERS.size[input.size] *
    PRICE_MULTIPLIERS.platforms[input.platforms] *
    PRICE_MULTIPLIERS.deadline[input.deadline];
  const minPrice = price ? roundDollar(price.min * multiplier) : null;
  const maxPrice = price ? roundDollar(price.max * multiplier) : null;
  const midPrice = minPrice !== null && maxPrice !== null ? roundDollar((minPrice + maxPrice) / 2) : null;
  const hasAdResults = input.type === "ads";
  const projections = hasAdResults
    ? adsProjections(budget.max, input.targeting)
    : { expectedReach: null, expectedVisits: null, expectedLeads: null };
  const estimatedAdDays = hasAdResults
    ? Math.max(1, Math.min(30, Math.floor((budget.max * ADS_PLANNING_ASSUMPTIONS.effectiveSpendShare) / ADS_PLANNING_ASSUMPTIONS.dailySpendForDuration)))
    : null;

  return {
    service: input.type,
    budgetBand: input.budget,
    budgetAmount: budget.max,
    budgetQuality: budget.quality,
    budgetLabel: budget.labelAr,
    budgetEmoji: budget.emoji,
    minPrice,
    maxPrice,
    midPrice,
    resultsKind: hasAdResults ? "numbers" : "none",
    ...projections,
    targeting: input.targeting,
    estimatedAdDays,
  };
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
