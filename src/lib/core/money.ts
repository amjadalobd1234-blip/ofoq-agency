/**
 * Money helpers.
 *
 * Every monetary value in the platform is an INTEGER in the currency's minor
 * unit (cents, fils, piastres…). Floating point is never used for stored money;
 * `round()` is only used when deriving display values from rates (e.g. pricing
 * multipliers) and always returns integer minor units.
 */

export interface CurrencyInfo {
  code: string;
  symbolEn: string;
  symbolAr: string;
  /** Number of decimal digits in the minor unit. */
  decimals: number;
}

export const CURRENCIES: Record<string, CurrencyInfo> = {
  USD: { code: "USD", symbolEn: "$", symbolAr: "$", decimals: 2 },
  EUR: { code: "EUR", symbolEn: "€", symbolAr: "€", decimals: 2 },
  GBP: { code: "GBP", symbolEn: "£", symbolAr: "£", decimals: 2 },
  AED: { code: "AED", symbolEn: "AED", symbolAr: "د.إ", decimals: 2 },
  SAR: { code: "SAR", symbolEn: "SAR", symbolAr: "ر.س", decimals: 2 },
  QAR: { code: "QAR", symbolEn: "QAR", symbolAr: "ر.ق", decimals: 2 },
  KWD: { code: "KWD", symbolEn: "KWD", symbolAr: "د.ك", decimals: 3 },
  BHD: { code: "BHD", symbolEn: "BHD", symbolAr: "د.ب", decimals: 3 },
  OMR: { code: "OMR", symbolEn: "OMR", symbolAr: "ر.ع", decimals: 3 },
  JOD: { code: "JOD", symbolEn: "JOD", symbolAr: "د.أ", decimals: 3 },
  EGP: { code: "EGP", symbolEn: "EGP", symbolAr: "ج.م", decimals: 2 },
  IQD: { code: "IQD", symbolEn: "IQD", symbolAr: "د.ع", decimals: 0 },
  TRY: { code: "TRY", symbolEn: "₺", symbolAr: "₺", decimals: 2 },
  INR: { code: "INR", symbolEn: "₹", symbolAr: "₹", decimals: 2 },
  PKR: { code: "PKR", symbolEn: "PKR", symbolAr: "روپے", decimals: 2 },
};

export const DEFAULT_CURRENCY = "USD";

export function currencyInfo(code: string | null | undefined): CurrencyInfo {
  const normalised = (code ?? DEFAULT_CURRENCY).toUpperCase();
  return (
    CURRENCIES[normalised] ?? {
      code: normalised,
      symbolEn: normalised,
      symbolAr: normalised,
      decimals: 2,
    }
  );
}

export function isSupportedCurrency(code: string | null | undefined): boolean {
  return Boolean(code && CURRENCIES[code.toUpperCase()]);
}

/** Converts a major-unit amount (e.g. 125.5) into minor units (12550). */
export function toMinor(amount: number | string, currency = DEFAULT_CURRENCY): number {
  const info = currencyInfo(currency);
  const value = typeof amount === "string" ? Number(amount.replace(/[^\d.-]/g, "")) : amount;
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 10 ** info.decimals);
}

/** Converts minor units back into a major-unit number (display/round-trip only). */
export function fromMinor(minor: number, currency = DEFAULT_CURRENCY): number {
  const info = currencyInfo(currency);
  return minor / 10 ** info.decimals;
}

export function round(value: number): number {
  return Math.round(value);
}

export function clampMinor(value: number, min = 0): number {
  return Math.max(min, Math.round(value));
}

export function sumMinor(values: number[]): number {
  return values.reduce((total, value) => total + Math.round(value), 0);
}

/** Percentage of an amount, rounded to whole minor units. */
export function percentOf(minor: number, percent: number): number {
  return Math.round((minor * percent) / 100);
}

export function applyDiscount(minor: number, discountMinor: number): number {
  return clampMinor(minor - Math.max(0, discountMinor));
}

export function marginPct(totalMinor: number, costMinor: number): number | null {
  if (totalMinor <= 0) return null;
  return Number((((totalMinor - costMinor) / totalMinor) * 100).toFixed(2));
}

/**
 * Formats minor units for display, e.g. `formatMoney(12500, "USD", "en")` → `$125.00`.
 * Arabic output keeps Latin digits for financial clarity while placing the
 * currency on the correct side for RTL.
 */
export function formatMoney(
  minor: number | null | undefined,
  currency = DEFAULT_CURRENCY,
  locale: "ar" | "en" = "ar",
): string {
  const info = currencyInfo(currency);
  const value = fromMinor(Math.round(minor ?? 0), currency);
  const formatted = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: info.decimals,
    maximumFractionDigits: info.decimals,
  }).format(value);
  const symbol = locale === "ar" ? info.symbolAr : info.symbolEn;
  if (locale === "ar") return `${formatted} ${symbol}`;
  // Currencies with letter symbols read better before the number.
  return /^[A-Z]{3}$/.test(symbol) ? `${symbol} ${formatted}` : `${symbol}${formatted}`;
}

/** Compact, human-readable money for reports: `$1.2K`, `د.ع 15 ألف`. */
export function formatMoneyCompact(
  minor: number | null | undefined,
  currency = DEFAULT_CURRENCY,
  locale: "ar" | "en" = "ar",
): string {
  const info = currencyInfo(currency);
  const value = fromMinor(Math.round(minor ?? 0), currency);
  const symbol = locale === "ar" ? info.symbolAr : info.symbolEn;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M ${symbol}`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K ${symbol}`;
  return formatMoney(minor, currency, locale);
}

/** Sums money values that may be in different currencies only when they match. */
export function assertSameCurrency(values: { currency: string }[]): string | null {
  const unique = new Set(values.map((value) => value.currency.toUpperCase()));
  if (unique.size === 0) return null;
  if (unique.size > 1) return null;
  return [...unique][0] ?? null;
}
