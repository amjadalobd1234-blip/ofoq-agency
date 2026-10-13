/**
 * Budget parsing for the guided service request — layer 1 (pattern matching).
 *
 * The client may answer the budget question, or revise the budget later in
 * the conversation, with free text instead of one of the four buttons:
 *
 *   «طيب من 200 إلى 500»   → range 200–500
 *   «200-500$» / «200 إلى 500» → range 200–500
 *   «ميزانيتي 350» / «$300» / «300 دولار» → single value
 *   «300» (only while the budget question itself is open) → single value
 *
 * Whatever the wording, the result is stored in ONE canonical shape:
 * `{ min, max }` with `min <= max`, rendered as `200-500` (never «500 من 200»),
 * and the planning amount the pricing uses is the upper bound of a range or the
 * single value the client typed.
 *
 * Pure: no React, no model, no database — unit-tested on its own. When no
 * pattern matches, the caller tries the AI intent layer (`budget-intent.ts`).
 */
import type { BudgetBand } from "./pricing-agent";

export interface ParsedBudget {
  /** Lower bound; equals `max` for a single value. */
  min: number;
  /** Upper bound — the planning amount used by the pricing agent. */
  max: number;
  kind: "single" | "range";
  /** Currency named in the message, when any (`USD` for `$`/دولار). */
  currency: "USD" | "IQD" | "OTHER" | null;
  /** The canonical text stored with the request: `200-500` or `350`. */
  text: string;
}

export interface ParseBudgetOptions {
  /**
   * Accept a bare number («300») as a budget. Only safe while the budget
   * question itself is open; elsewhere a number may be a phone, a post count…
   */
  bareNumbers?: boolean;
}

/** Amounts outside this window are typos or not budgets at all. */
export const MIN_BUDGET_AMOUNT = 1;
export const MAX_BUDGET_AMOUNT = 1_000_000;

const ARABIC_INDIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const EXTENDED_ARABIC_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

/** Arabic-Indic and Persian digits → Latin digits; tatweel/diacritics dropped. */
export function normalizeBudgetText(value: string): string {
  return (value ?? "")
    .toString()
    .replace(/[٠-٩]/g, (digit) => String(ARABIC_INDIC_DIGITS.indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String(EXTENDED_ARABIC_DIGITS.indexOf(digit)))
    .replace(/[\u064B-\u0652\u0670\u0640]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/[–—−]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** One amount: digits with optional separators and an optional ×1000 suffix. */
const AMOUNT = String.raw`(\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?)\s*(k|ألف|الف|آلاف|الاف|thousand)?`;
/** Currency words that may follow (or precede) an amount. */
const CURRENCY = String.raw`(?:\$|usd|دولار|دولارات|دينار|د\.ع|iqd|€|eur|يورو|aed|درهم|sar|ريال)`;
const RANGE_SEPARATOR = String.raw`(?:\s*-\s*|\s+(?:إلى|الى|ل|لـ|لحد|حتى|لغاية|to|و)\s+|\s+(?:إلى|الى)\s*)`;

const EXPLICIT_RANGE_PATTERNS: RegExp[] = [
  // «من 200 إلى 500», «من 200$ ل 500$», «من 200 - 500»
  new RegExp(String.raw`(?:^|[\s(])(?:من|from)\s*\$?\s*${AMOUNT}\s*${CURRENCY}?${RANGE_SEPARATOR}\$?\s*${AMOUNT}\s*${CURRENCY}?`, "u"),
  // «بين 200 و 500», «between 200 and 500»
  new RegExp(String.raw`(?:^|[\s(])(?:بين|ما بين|between)\s*\$?\s*${AMOUNT}\s*${CURRENCY}?\s*(?:و|and|-)\s*\$?\s*${AMOUNT}\s*${CURRENCY}?`, "u"),
];

/** «200-500$», «$200-500», «200 إلى 500», «200 to 500». */
const COMPACT_RANGE_PATTERN = new RegExp(
  String.raw`(?:^|[^\d.,])\$?\s*${AMOUNT}\s*${CURRENCY}?${RANGE_SEPARATOR}\$?\s*${AMOUNT}\s*${CURRENCY}?(?!\s*(?:يوم|أيام|ايام|منشور|بوست|post|day))`,
  "u",
);

/** Words that say "this number is my budget". */
const BUDGET_CUE = String.raw`(?:ميزانيتي|ميزانيتنا|ميزانية|الميزانية|ميزانيه|الميزانيه|budget|بحدود|حدود|حوالي|تقريبا|تقريباً|around|about|approx(?:imately)?|اقدر ادفع|أقدر أدفع|ادفع|أدفع|سادفع|سأدفع|مخصص|خصصت)`;

const CUED_SINGLE_PATTERNS: RegExp[] = [
  // «ميزانيتي 350», «الميزانية تقريباً 1000», «budget is 500»
  new RegExp(String.raw`${BUDGET_CUE}\s*(?:هي|هو|تكون|راح تكون|is|of|:)?\s*(?:\S+\s+){0,2}?\$?\s*${AMOUNT}\s*${CURRENCY}?`, "u"),
  // «$300», «300$», «300 دولار», «300 usd»
  new RegExp(String.raw`(?:^|[^\d.,])\$\s*${AMOUNT}`, "u"),
  new RegExp(String.raw`(?:^|[^\d.,])${AMOUNT}\s*${CURRENCY}`, "u"),
];

const BARE_SINGLE_PATTERN = new RegExp(String.raw`^\s*\$?\s*${AMOUNT}\s*${CURRENCY}?\s*[.!؟?]*\s*$`, "u");

function toAmount(raw: string | undefined, suffix: string | undefined): number | null {
  if (!raw) return null;
  // «0770…» is a phone number fragment, never a budget.
  if (/^0\d/.test(raw)) return null;
  let value: number;
  if (/^\d{1,3}(?:[.,]\d{3})+$/.test(raw)) {
    value = Number(raw.replace(/[.,]/g, ""));
  } else {
    value = Number(raw.replace(",", "."));
  }
  if (!Number.isFinite(value)) return null;
  if (suffix) value *= 1_000;
  value = Math.round(value);
  if (value < MIN_BUDGET_AMOUNT || value > MAX_BUDGET_AMOUNT) return null;
  return value;
}

function detectCurrency(text: string): ParsedBudget["currency"] {
  if (/\$|usd|دولار/.test(text)) return "USD";
  if (/دينار|د\.ع|iqd/.test(text)) return "IQD";
  if (/€|eur|يورو|aed|درهم|sar|ريال/.test(text)) return "OTHER";
  return null;
}

/** Canonical text: `200-500` for a range, `350` for a single value. */
export function formatBudgetRange(budget: { min: number; max: number }): string {
  const min = Math.round(Math.min(budget.min, budget.max));
  const max = Math.round(Math.max(budget.min, budget.max));
  return min === max ? String(max) : `${min}-${max}`;
}

/** Builds the canonical result from one or two amounts (order-independent). */
export function budgetFromAmounts(first: number, second: number | null | undefined, currency: ParsedBudget["currency"] = null): ParsedBudget {
  const low = second === null || second === undefined ? first : Math.min(first, second);
  const high = second === null || second === undefined ? first : Math.max(first, second);
  return {
    min: low,
    max: high,
    kind: low === high ? "single" : "range",
    currency,
    text: formatBudgetRange({ min: low, max: high }),
  };
}

/**
 * Parses a budget out of free text. Returns `null` when the message does not
 * state a budget the deterministic layer is sure about — the caller then asks
 * the AI intent layer, and finally shows the options again.
 */
export function parseBudgetText(input: string, options: ParseBudgetOptions = {}): ParsedBudget | null {
  // Dates («2026-10-13», «13/10/2026») and clock times («10:30») carry
  // hyphenated digits that are not a range — they are blanked before matching.
  const text = normalizeBudgetText(input)
    .replace(/\b\d{4}-\d{1,2}-\d{1,2}\b|\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b|\b\d{1,2}:\d{2}\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  const currency = detectCurrency(text);

  for (const pattern of EXPLICIT_RANGE_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      const first = toAmount(match[1], match[2]);
      const second = toAmount(match[3], match[4]);
      if (first !== null && second !== null) return budgetFromAmounts(first, second, currency);
    }
  }

  const compact = COMPACT_RANGE_PATTERN.exec(text);
  if (compact) {
    const first = toAmount(compact[1], compact[2]);
    const second = toAmount(compact[3], compact[4]);
    if (first !== null && second !== null) return budgetFromAmounts(first, second, currency);
  }

  for (const pattern of CUED_SINGLE_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      const amount = toAmount(match[1], match[2]);
      if (amount !== null) return budgetFromAmounts(amount, null, currency);
    }
  }

  if (options.bareNumbers) {
    const bare = BARE_SINGLE_PATTERN.exec(text);
    if (bare) {
      const amount = toAmount(bare[1], bare[2]);
      if (amount !== null) return budgetFromAmounts(amount, null, currency);
    }
  }

  return null;
}

/** True when the message carries a number — the only case worth an AI call. */
export function mentionsNumber(input: string): boolean {
  return /\d/.test(normalizeBudgetText(input));
}

/**
 * True when the only numbers in the message form a phone number («رقمي
 * 07707048629», «+964 770 704 8629»): never a budget, so not worth an AI call
 * either — the budget patterns already ignore such digits.
 */
export function looksLikePhoneNumber(input: string): boolean {
  const text = normalizeBudgetText(input);
  if (!/\d/.test(text)) return false;
  const digits = text.replace(/\D/g, "");
  const phone = /^(?:00)?(?:964)?0?7\d{9}$/.test(digits) || /^(?:00)?9647\d{9}$/.test(digits);
  return phone && !/(?:\$|دولار|usd|ميزاني|الميزانية|budget)/.test(text);
}

/**
 * The published budget band an amount falls in. The thresholds are the
 * band labels' upper bounds (≤ 200, ≤ 500, ≤ 1500, above), so the band of a
 * typed amount matches the button the client would have pressed.
 */
export function budgetBandForAmount(amount: number): BudgetBand {
  if (amount <= 200) return "under_200";
  if (amount <= 500) return "200_500";
  if (amount <= 1_500) return "500_1500";
  return "over_1500";
}

/** Budget details stored with the request alongside the band id. */
export interface BudgetDetail {
  /** Canonical range text: `200-500` or `350`. */
  range: string;
  /** Planning amount in USD (upper bound of the range, or the single value). */
  amount: number;
}

export function budgetDetailFromParsed(parsed: ParsedBudget): BudgetDetail {
  return { range: parsed.text, amount: parsed.max };
}

/** Parses a stored canonical range (`200-500` / `350`) back into bounds. */
export function parseBudgetRangeText(value: string | null | undefined): { min: number; max: number } | null {
  const text = (value ?? "").trim();
  const match = /^(\d+)(?:-(\d+))?$/.exec(text);
  if (!match) return null;
  const first = Number(match[1]);
  const second = match[2] ? Number(match[2]) : first;
  if (!Number.isFinite(first) || !Number.isFinite(second)) return null;
  return { min: Math.min(first, second), max: Math.max(first, second) };
}
