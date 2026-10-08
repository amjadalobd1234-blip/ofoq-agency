import { cookies, headers } from "next/headers";

import type { Locale } from "@/lib/domain/types";
import { LOCALES, type Dictionary, dictionaries, isLocale } from "./dictionaries";

export const LOCALE_COOKIE = "ofoq_locale";

/** Locale resolution order: explicit cookie → accepted language header → Arabic. */
export function resolveLocaleFromCookie(value: string | undefined): Locale {
  return isLocale(value) ? value : "ar";
}

export function pickLocaleFromHeader(header: string | undefined): Locale {
  if (!header) return "ar";
  const parts = header
    .split(",")
    .map((part) => part.split(";")[0]!.trim().toLowerCase())
    .filter(Boolean);
  for (const part of parts) {
    if (part.startsWith("ar")) return "ar";
    if (part.startsWith("en")) return "en";
  }
  return "ar";
}

/** Reads the active locale on the server (cookie first, then Accept-Language). */
export async function getLocale(): Promise<Locale> {
  const store = await cookies();
  const fromCookie = store.get(LOCALE_COOKIE)?.value;
  if (isLocale(fromCookie)) return fromCookie;
  const requestHeaders = await headers();
  return pickLocaleFromHeader(requestHeaders.get("accept-language") ?? undefined);
}

export function dir(locale: Locale): "rtl" | "ltr" {
  return locale === "ar" ? "rtl" : "ltr";
}

/** Dictionary accessor: `const d = await getDictionary()` then `d.nav.services`. */
export async function getDictionary(locale?: Locale): Promise<Dictionary> {
  const active = locale ?? (await getLocale());
  return dictionaries[active];
}

export { LOCALES, dictionaries, isLocale };
export type { Dictionary };
export type { Locale };

/**
 * Formats a number/date for the active locale. Arabic uses Arabic-Indic digits
 * only where the owner prefers them; the default keeps Latin digits because they
 * are easier to scan in tables and invoices.
 */
export function formatNumber(value: number, locale: Locale): string {
  return new Intl.NumberFormat(locale === "ar" ? "ar-IQ-u-nu-latn" : "en-US").format(value);
}

export function formatDate(value: string | Date, locale: Locale): string {
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-IQ-u-nu-latn" : "en-GB", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
}

export function formatDateTime(value: string | Date, locale: Locale): string {
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-IQ-u-nu-latn" : "en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

/** Bilingual field picker used by every content row that stores ar + en. */
export function pick(
  locale: Locale,
  arabic: string | null | undefined,
  english: string | null | undefined,
  fallback = "",
): string {
  const primary = locale === "ar" ? arabic : english;
  const secondary = locale === "ar" ? english : arabic;
  return primary?.trim() || secondary?.trim() || fallback;
}
