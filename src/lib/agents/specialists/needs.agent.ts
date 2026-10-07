import { aiCompleteJson } from "@/lib/ai/provider";
import {
  detectBudget,
  detectPlatforms,
  detectPostCount,
  detectServiceHints,
  detectTimelineDays,
  platformLabel,
  resolveLocale,
  serviceLabel,
  slotLabel,
  t,
} from "@/lib/ai/language";
import { toMinor } from "@/lib/core/money";
import { addDays, toDateKey } from "@/lib/core/date";
import type { CustomerRow, Locale } from "@/lib/domain/types";
import { listServices } from "@/lib/repositories/catalog.repo";
import { factsToMap, upsertCustomerFact } from "@/lib/repositories/customers.repo";

import { runAgent } from "../runtime";

/**
 * Needs analyst.
 *
 * Turns conversation text into a structured requirement profile stored as
 * client facts. Facts keep their provenance ("CHAT", "AGENT", "STAFF") so the
 * agency can see and correct anything an agent inferred.
 *
 * Facts are always a merge of what the client already told us and what this
 * message adds — the agent never invents a value for a slot that is still
 * unknown; unknown slots are reported through `missing` so the assistant can ask.
 */

export const REQUIRED_SLOTS = ["goal", "services", "platforms", "volume", "timeline", "budget", "market"] as const;
export type RequirementSlot = (typeof REQUIRED_SLOTS)[number];

export interface RequirementProfile {
  customerId: string;
  locale: Locale;
  goal: string | null;
  services: string[];
  platforms: string[];
  volume: number | null;
  timelineDays: number | null;
  budgetMaxMinor: number | null;
  budgetCurrency: string | null;
  country: string | null;
  marketCountries: string[];
  notes: string[];
  /** Percentage of the slots that are filled (0-100). */
  completeness: number;
  missing: RequirementSlot[];
  /** Slots the client explicitly skipped ("not sure"). */
  skipped: RequirementSlot[];
}

/** Shape requested from the model when it is available (all keys optional). */
interface AiExtraction {
  goal?: string;
  services?: string[] | string;
  platforms?: string[] | string;
  volume?: number | string;
  timeline_days?: number | string;
  budget_amount?: number | string;
  budget_currency?: string;
  country?: string;
}

interface FactBag {
  goal?: string;
  services?: string;
  platforms?: string;
  volume?: string;
  timeline_days?: string;
  budget_max_minor?: string;
  budget_currency?: string;
  country?: string;
  skipped_slots?: string;
  notes?: string;
  market_countries?: string;
  discovery_stage?: string;
}

/** Slots that only matter for certain services. */
function relevantSlots(services: string[]): RequirementSlot[] {
  const slots: RequirementSlot[] = ["goal", "services", "timeline", "budget", "market"];
  const socialOrAds = services.some((slug) =>
    ["social-media-management", "paid-ads", "content-design", "content-strategy"].includes(slug),
  );
  if (socialOrAds) {
    slots.splice(2, 0, "platforms");
    slots.splice(3, 0, "volume");
  }
  return slots;
}

/** Reads the requirement profile from stored facts. */
export function profileFromFacts(customer: CustomerRow, facts: Record<string, string>): RequirementProfile {
  const services = parseList(facts.services);
  const skipped = parseList(facts.skipped_slots) as RequirementSlot[];
  const relevant = relevantSlots(services.length > 0 ? services : ["consulting"]);
  const missing = relevant.filter((slot) => {
    if (skipped.includes(slot)) return false;
    // Every slot maps to the fact key that actually stores it: "timeline" lives in
    // `timeline_days`, "budget" in `budget_max_minor`, and "market" is satisfied by
    // the country captured at registration.
    switch (slot) {
      case "services":
        return services.length === 0;
      case "platforms":
        return parseList(facts.platforms).length === 0;
      case "volume":
        return !facts.volume;
      case "timeline":
        return !facts.timeline_days;
      case "budget":
        return !facts.budget_max_minor;
      case "market":
        return !facts.country && !customer.country && parseList(facts.market_countries).length === 0;
      case "goal":
      default:
        return !facts.goal;
    }
  });

  const relevantFilled = relevant.filter((slot) => !missing.includes(slot)).length;

  return {
    customerId: customer.id,
    locale: customer.locale,
    goal: facts.goal ?? null,
    services,
    platforms: parseList(facts.platforms),
    volume: facts.volume ? Number(facts.volume) : null,
    timelineDays: facts.timeline_days ? Number(facts.timeline_days) : null,
    budgetMaxMinor: facts.budget_max_minor ? Number(facts.budget_max_minor) : null,
    budgetCurrency: facts.budget_currency ?? null,
    country: facts.country ?? null,
    marketCountries: facts.market_countries ? parseList(facts.market_countries) : [],
    notes: parseList(facts.notes),
    completeness: relevant.length === 0 ? 100 : Math.round((relevantFilled / relevant.length) * 100),
    missing,
    skipped,
  };
}

export async function loadProfile(customer: CustomerRow): Promise<RequirementProfile> {
  const facts = await factsToMap(customer.id);
  return profileFromFacts(customer, facts);
}

export interface ExtractResult {
  profile: RequirementProfile;
  /** True when this message added or changed at least one fact. */
  changed: boolean;
}

/**
 * Extracts facts from a client message and merges them into the client file.
 * Runs the rules engine first (always), then — if a model provider is
 * configured — lets the model fill remaining gaps from free text.
 */
export async function extractRequirements(
  customer: CustomerRow,
  message: string,
  options: { conversationId?: string | null; source?: "CHAT" | "STAFF" | "AGENT" } = {},
): Promise<ExtractResult> {
  const facts = await factsToMap(customer.id);
  const before = JSON.stringify(facts);
  const updates: { key: keyof FactBag; value: string; confidence: number }[] = [];

  const goal = detectGoal(message);
  if (goal && !facts.goal) updates.push({ key: "goal", value: goal, confidence: 0.7 });

  const serviceHints = detectServiceHints(message);
  if (serviceHints.length > 0) {
    const slugs = serviceHints.map((hint) => hint.replace(/_/g, "-"));
    const merged = Array.from(new Set([...parseList(facts.services), ...slugs]));
    updates.push({ key: "services", value: merged.join(","), confidence: 0.8 });
  }

  const platforms = detectPlatforms(message);
  if (platforms.length > 0) {
    const merged = Array.from(new Set([...parseList(facts.platforms), ...platforms]));
    updates.push({ key: "platforms", value: merged.join(","), confidence: 0.85 });
  }

  const postCount = detectPostCount(message);
  if (postCount) updates.push({ key: "volume", value: String(postCount), confidence: 0.85 });

  const timeline = detectTimelineDays(message);
  if (timeline) updates.push({ key: "timeline_days", value: String(timeline), confidence: 0.8 });

  const budget = detectBudget(message);
  if (budget?.max || budget?.min) {
    const currency = budget.currency ?? facts.budget_currency ?? customer.currency ?? "USD";
    const amount = budget.max ?? budget.min ?? 0;
    updates.push({
      key: "budget_max_minor",
      value: String(toMinor(amount, currency)),
      confidence: 0.75,
    });
    updates.push({ key: "budget_currency", value: currency, confidence: 0.9 });
  }

  const country = detectCountry(message);
  if (country && !facts.country) updates.push({ key: "country", value: country, confidence: 0.7 });

  if (isSkipAnswer(message)) {
    const profile = profileFromFacts(customer, facts);
    if (profile.missing.length > 0) {
      const skipped = Array.from(new Set([...profile.skipped, profile.missing[0]!]));
      updates.push({ key: "skipped_slots", value: skipped.join(","), confidence: 1 });
      updates.push({
        key: "notes",
        value: appendNote(facts.notes, `client skipped: ${profile.missing[0]}`),
        confidence: 1,
      });
    }
  }

  const notSureBudget = /not sure|غير محدد|غير متأكد|ماعندي|لا أعرف|لا اعرف/i.test(message);
  if (notSureBudget && relevantSlots(parseList(facts.services)).includes("budget")) {
    const skipped = Array.from(new Set([...parseList(facts.skipped_slots), "budget"]));
    updates.push({ key: "skipped_slots", value: skipped.join(","), confidence: 1 });
  }

  // Optional model-assisted extraction for the slots the rules missed.
  const profileAfterRules = profileFromFacts(customer, { ...facts, ...toFactRecord(updates) });
  if (profileAfterRules.missing.length > 0 && message.length > 12) {
    const extracted = await aiCompleteJson<AiExtraction>({
      messages: [
        {
          role: "system",
          content:
            "You extract structured requirements for a digital marketing agency from a client message. " +
            "Answer ONLY with a JSON object. Use these keys when the message clearly states them: " +
            'goal, services (array of slugs from: social-media-management, content-design, content-strategy, ' +
            "paid-ads, branding, web-development, seo, analytics-reports, consulting), platforms (array), " +
            "volume (number), timeline_days (number), budget_amount (number), budget_currency (ISO code), " +
            "country (ISO code). " +
            "Omit any key the client did not clearly state. NEVER guess or invent values.",
        },
        { role: "user", content: message },
      ],
      temperature: 0,
    });

    if (extracted) {
      if (extracted.services && !facts.services) {
        updates.push({ key: "services", value: asArray(extracted.services).join(","), confidence: 0.7 });
      }
      if (extracted.platforms && !facts.platforms) {
        const merged = Array.from(new Set([...parseList(facts.platforms), ...asArray(extracted.platforms)]));
        updates.push({ key: "platforms", value: merged.join(","), confidence: 0.7 });
      }
      if (extracted.goal && !facts.goal) {
        updates.push({ key: "goal", value: String(extracted.goal).slice(0, 500), confidence: 0.7 });
      }
      if (extracted.volume && !facts.volume) {
        updates.push({ key: "volume", value: String(Number(extracted.volume) || ""), confidence: 0.7 });
      }
      if (extracted.timeline_days && !facts.timeline_days) {
        updates.push({ key: "timeline_days", value: String(Number(extracted.timeline_days) || ""), confidence: 0.7 });
      }
      if (extracted.budget_amount && !facts.budget_max_minor) {
        const currency = String(extracted.budget_currency ?? customer.currency ?? "USD").toUpperCase();
        updates.push({
          key: "budget_max_minor",
          value: String(toMinor(Number(extracted.budget_amount), currency)),
          confidence: 0.6,
        });
        updates.push({ key: "budget_currency", value: currency, confidence: 0.7 });
      }
      if (extracted.country && !facts.country) {
        updates.push({ key: "country", value: String(extracted.country).toUpperCase().slice(0, 3), confidence: 0.6 });
      }
    }
  }

  for (const update of updates) {
    if (!update.value) continue;
    await upsertCustomerFact({
      customer_id: customer.id,
      fact_key: update.key,
      fact_value: update.value,
      source: options.source ?? "CHAT",
      confidence: update.confidence,
      recorded_by: options.source === "STAFF" ? "staff" : "needs_analyst",
    });
  }

  const afterFacts = await factsToMap(customer.id);
  const changed = JSON.stringify(afterFacts) !== before;

  if (changed) {
    await runAgent(
      "needs_analyst",
      {
        trigger: "chat.message",
        locale: resolveLocale(message, customer.locale),
        customerId: customer.id,
        conversationId: options.conversationId ?? null,
        input: { messageLength: message.length, extractedKeys: updates.map((update) => update.key) },
      },
      async ({ record }) => {
        record({
          action: "facts.update",
          summary: `تم تحديث ${updates.length} معلومة في ملف العميل`,
          reason: "استخراج الاحتياج من رسالة العميل",
          entityType: "customer",
          entityId: customer.id,
          riskLevel: "LOW",
        });
        return {
          data: { updatedKeys: updates.map((update) => update.key) },
          summary: `تحديث بيانات الاحتياج (${updates.length} معلومة)`,
          riskLevel: "LOW",
        };
      },
    );
  }

  return { profile: profileFromFacts(customer, afterFacts), changed };
}

/**
 * Builds the next question the assistant should ask.
 * Only the necessary slots are asked, one at a time, in a natural order.
 */
export function nextQuestion(
  profile: RequirementProfile,
  locale: Locale,
): { slot: RequirementSlot | null; text: string; quickReplies: string[] } {
  const slot = profile.missing[0] ?? null;
  if (!slot) return { slot: null, text: "", quickReplies: [] };

  const copy: Record<RequirementSlot, { key: Parameters<typeof t>[0]; quick: string[] }> = {
    goal: { key: "askGoal", quick: [] },
    services: {
      key: "askService",
      quick:
        locale === "ar"
          ? [
              "إدارة حسابات التواصل",
              "كتابة وتصميم منشورات",
              "إعلانات مدفوعة",
              "موقع إلكتروني",
              "تحسين محركات البحث",
            ]
          : ["Social media management", "Posts and design", "Paid ads", "Website", "SEO"],
    },
    platforms: {
      key: "askPlatforms",
      quick:
        locale === "ar"
          ? ["إنستغرام وفيسبوك", "تيك توك", "إكس", "لينكد إن", "جوجل"]
          : ["Instagram and Facebook", "TikTok", "X", "LinkedIn", "Google"],
    },
    volume: {
      key: "askVolume",
      quick: locale === "ar" ? ["٨ منشورات", "١٢ منشورًا", "٢٠ منشورًا"] : ["8 posts", "12 posts", "20 posts"],
    },
    timeline: {
      key: "askTimeline",
      quick: locale === "ar" ? ["خلال أسبوع", "خلال شهر", "مرن"] : ["Within a week", "Within a month", "Flexible"],
    },
    budget: {
      key: "askBudget",
      quick: locale === "ar" ? ["غير محدد"] : ["Not sure"],
    },
    market: {
      key: "askCountry",
      quick: locale === "ar" ? ["العراق", "الإمارات", "السعودية", "أخرى"] : ["Iraq", "UAE", "Saudi Arabia", "Other"],
    },
  };

  const entry = copy[slot];
  return { slot, text: t(entry.key, locale), quickReplies: entry.quick };
}

/** Human-readable summary the assistant shows before confirming (step 7 & 8). */
export function buildSummary(profile: RequirementProfile, locale: Locale): string {
  const lines: string[] = [];
  const bilingual = (ar: string, en: string) => (locale === "ar" ? ar : en);

  if (profile.goal) lines.push(`• ${bilingual("الهدف", "Goal")}: ${profile.goal}`);
  if (profile.services.length > 0) {
    const names = profile.services.map((slug) => serviceLabel(slug, locale)).join(locale === "ar" ? "، " : ", ");
    lines.push(`• ${bilingual("الخدمات", "Services")}: ${names}`);
  }
  if (profile.platforms.length > 0) {
    const names = profile.platforms.map((key) => platformLabel(key, locale)).join(locale === "ar" ? "، " : ", ");
    lines.push(`• ${bilingual("المنصات", "Platforms")}: ${names}`);
  }
  if (profile.volume) {
    lines.push(
      `• ${bilingual("الكمية", "Volume")}: ${profile.volume} ${bilingual("منشور/مادة", "posts/items")}`,
    );
  }
  if (profile.timelineDays) {
    const start = addDays(new Date(), 1);
    lines.push(
      `• ${bilingual("الموعد المتوقع", "Expected timeline")}: ${profile.timelineDays} ${
        locale === "ar" ? "يوم" : "days"
      } (${bilingual("بدء مقترح", "proposed start")}: ${toDateKey(start)})`,
    );
  }
  if (profile.country) lines.push(`• ${bilingual("السوق", "Market")}: ${profile.country}`);
  if (profile.budgetMaxMinor) {
    lines.push(
      `• ${bilingual("الميزانية المذكورة", "Stated budget")}: ${profile.budgetMaxMinor / 100} ${
        profile.budgetCurrency ?? "USD"
      }`,
    );
  }
  const skipped = profile.skipped.filter((slot) => !profile.missing.includes(slot));
  if (skipped.length > 0) {
    const names = skipped.map((slot) => slotLabel(slot, locale)).join(locale === "ar" ? "، " : ", ");
    lines.push(`• ${bilingual("بنود لم يحددها العميل", "Items the client left open")}: ${names}`);
  }

  return `${t("summaryIntro", locale)}\n${lines.join("\n")}`;
}

/* ------------------------------------------------------------------ helpers */

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function asArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value === "string") return value.split(",").map((item) => item.trim());
  return [];
}

function toFactRecord(updates: { key: keyof FactBag; value: string }[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (const update of updates) record[update.key] = update.value;
  return record;
}

function appendNote(existing: string | undefined, note: string): string {
  const notes = parseList(existing);
  if (notes.includes(note)) return notes.join(",");
  return [...notes, note].join(",");
}

function detectGoal(message: string): string | null {
  const patterns = [
    /(?:goal|objective|هدف|أريد|اريد|نريد|هدفي)\s*[:\-]?\s*(.{5,120})/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(message);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

const COUNTRY_ALIASES: Record<string, string> = {
  iraq: "IQ",
  العراق: "IQ",
  بغداد: "IQ",
  uae: "AE",
  إمارات: "AE",
  الامارات: "AE",
  الإمارات: "AE",
  dubai: "AE",
  دبي: "AE",
  saudi: "SA",
  السعودية: "SA",
  الرياض: "SA",
  قطر: "QA",
  qatar: "QA",
  kuweit: "KW",
  kuwait: "KW",
  الكويت: "KW",
  jordan: "JO",
  الأردن: "JO",
  الاردن: "JO",
  egypt: "EG",
  مصر: "EG",
  turkey: "TR",
  تركيا: "TR",
  "united states": "US",
  usa: "US",
  أمريكا: "US",
  america: "US",
  "united kingdom": "GB",
  britain: "GB",
  london: "GB",
  britain2: "GB",
  canada: "CA",
  كندا: "CA",
  australia: "AU",
  أستراليا: "AU",
  germany: "DE",
  ألمانيا: "DE",
  germany2: "DE",
};

export function detectCountry(message: string): string | null {
  const haystack = message.toLowerCase();
  for (const [alias, code] of Object.entries(COUNTRY_ALIASES)) {
    if (haystack.includes(alias.toLowerCase())) return code;
  }
  return null;
}

function isSkipAnswer(message: string): boolean {
  return /^(skip|no idea|not sure|غير محدد|تخطى|تخطي|لا أعرف|لا اعرف|ماعرف|بدون)$/i.test(message.trim());
}

/** Ensures the customer record has a currency consistent with the market. */
export async function suggestedCurrency(profile: RequirementProfile): Promise<string | null> {
  const services = await listServices({ activeOnly: true });
  if (services.length === 0) return null;
  return profile.budgetCurrency ?? services[0]?.currency ?? null;
}
