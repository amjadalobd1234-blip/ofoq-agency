/**
 * Date helpers.
 *
 * Everything is stored as ISO-8601 UTC text so the values sort correctly as
 * plain strings and behave identically on SQLite and PostgreSQL.
 */

export type ISODate = string;

export function nowIso(): ISODate {
  return new Date().toISOString();
}

export function toIso(value: Date | string | number): ISODate {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** `YYYY-MM-DD` for a date or timestamp. */
export function toDateKey(value: Date | string | number = new Date()): string {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString().slice(0, 10);
}

export function addDays(value: Date | string, days: number): Date {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date;
}

/** Calendar-aware month addition that clamps to the end of the target month. */
export function addHours(value: Date | string, hours: number): Date {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  date.setUTCHours(date.getUTCHours() + hours);
  return date;
}

export function addMonths(value: Date | string, months: number): Date {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  const day = date.getUTCDate();
  const target = new Date(date);
  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() + months);
  const daysInTargetMonth = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, daysInTargetMonth));
  return target;
}

export function startOfDay(value: Date | string = new Date()): Date {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

export function endOfDay(value: Date | string = new Date()): Date {
  const date = startOfDay(value);
  date.setUTCHours(23, 59, 59, 999);
  return date;
}

export function isPast(value: Date | string | null | undefined, reference: Date = new Date()): boolean {
  if (!value) return false;
  return new Date(value).getTime() < reference.getTime();
}

export function daysBetween(from: Date | string, to: Date | string): number {
  const start = startOfDay(from).getTime();
  const end = startOfDay(to).getTime();
  return Math.round((end - start) / 86_400_000);
}

/** Inclusive list of `YYYY-MM-DD` keys between two dates (max 366 entries). */
export function dateRangeKeys(from: Date | string, to: Date | string): string[] {
  const keys: string[] = [];
  const limit = Math.min(366, Math.max(0, daysBetween(from, to)) + 1);
  const start = startOfDay(from);
  for (let i = 0; i < limit; i += 1) {
    keys.push(toDateKey(addDays(start, i)));
  }
  return keys;
}

/** Period bounds used by subscriptions and reports. */
export function periodBounds(start: Date | string, interval: "MONTHLY" | "QUARTERLY" | "YEARLY"): {
  start: Date;
  end: Date;
} {
  const startDate = startOfDay(start);
  const months = interval === "MONTHLY" ? 1 : interval === "QUARTERLY" ? 3 : 12;
  const end = endOfDay(addDays(addMonths(startDate, months), -1));
  return { start: startDate, end };
}

const AR_MONTHS = [
  "يناير",
  "فبراير",
  "مارس",
  "أبريل",
  "مايو",
  "يونيو",
  "يوليو",
  "أغسطس",
  "سبتمبر",
  "أكتوبر",
  "نوفمبر",
  "ديسمبر",
];

/** Locale-aware short date. `locale` is `ar` or `en`. */
export function formatDate(
  value: Date | string | null | undefined,
  locale: "ar" | "en" = "ar",
  style: "short" | "long" = "short",
): string {
  if (!value) return locale === "ar" ? "—" : "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  if (locale === "ar") {
    const day = date.getUTCDate();
    const month = AR_MONTHS[date.getUTCMonth()] ?? "";
    return style === "long" ? `${day} ${month} ${date.getUTCFullYear()}` : `${day} ${month}`;
  }
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: style === "long" ? "long" : "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

export function formatDateTime(value: Date | string | null | undefined, locale: "ar" | "en" = "ar"): string {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const time = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(date);
  return `${formatDate(date, locale)} · ${time}`;
}
