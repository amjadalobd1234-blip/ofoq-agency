import { getEnv } from "@/lib/config/env";
import type { BillingType, ServiceUnit } from "@/lib/domain/types";
import { AGENT_DEFINITIONS } from "@/lib/agents/registry";
import { createService, listServices } from "@/lib/repositories/catalog.repo";
import { seedOrUpdateAgentRows } from "@/lib/repositories/agents.repo";
import { getSetting, setSetting } from "@/lib/repositories/governance.repo";

/**
 * Baseline data every installation needs: the starting service catalogue, the
 * agent registry rows and the default settings.
 *
 * Shared by `npm run db:seed` and the test setup so tests run against exactly the
 * same starting point as a real deployment. It is idempotent: running it twice
 * changes nothing and never overwrites values the owner has edited.
 */

export interface SeedServiceDefinition {
  slug: string;
  name_ar: string;
  name_en: string;
  short_ar: string;
  short_en: string;
  category: string;
  billing_type: BillingType;
  unit: ServiceUnit;
  base_price_minor: number;
  min_price_minor: number;
  delivery_days: number;
  revisions_included: number;
  sort_order: number;
}

/**
 * Starter catalogue.
 *
 * PRICES ARE DELIBERATE STARTING POINTS the owner/partner can change from the
 * dashboard at any time. They are policy figures for a new agency with no
 * historical projects — they are NOT market research and NOT client outcomes.
 * All values are in minor units (cents) of the default currency.
 */
export const SEED_SERVICES: SeedServiceDefinition[] = [
  {
    slug: "social-media-management",
    name_ar: "إدارة حسابات التواصل الاجتماعي",
    name_en: "Social media management",
    short_ar: "إدارة يومية لحساباتك مع خطة نشر ومتابعة.",
    short_en: "Day-to-day management of your accounts with a plan and follow-up.",
    category: "social",
    billing_type: "SUBSCRIPTION",
    unit: "MONTH",
    base_price_minor: 25_000,
    min_price_minor: 15_000,
    delivery_days: 30,
    revisions_included: 3,
    sort_order: 1,
  },
  {
    slug: "content-design",
    name_ar: "كتابة وتصميم المنشورات",
    name_en: "Post writing and design",
    short_ar: "نصوص وتصاميم جاهزة للنشر مع مراجعة قبل النشر.",
    short_en: "Ready-to-publish copy and designs, reviewed before publishing.",
    category: "content",
    billing_type: "SUBSCRIPTION",
    unit: "POST",
    base_price_minor: 1_800,
    min_price_minor: 1_000,
    delivery_days: 5,
    revisions_included: 2,
    sort_order: 2,
  },
  {
    slug: "content-strategy",
    name_ar: "صناعة المحتوى وخطط النشر",
    name_en: "Content creation and publishing plans",
    short_ar: "خطة محتوى شهرية بأهداف واضحة ومواضيع محددة.",
    short_en: "A monthly content plan with clear objectives and defined topics.",
    category: "content",
    billing_type: "ONE_TIME",
    unit: "PROJECT",
    base_price_minor: 30_000,
    min_price_minor: 18_000,
    delivery_days: 10,
    revisions_included: 2,
    sort_order: 3,
  },
  {
    slug: "paid-ads",
    name_ar: "إدارة الإعلانات المدفوعة",
    name_en: "Paid ads management",
    short_ar: "تخطيط الحملة ومتابعة الأرقام وتحسينها داخل ميزانيتك.",
    short_en: "Campaign planning, monitoring and optimisation inside your budget.",
    category: "growth",
    billing_type: "SUBSCRIPTION",
    unit: "MONTH",
    base_price_minor: 40_000,
    min_price_minor: 25_000,
    delivery_days: 30,
    revisions_included: 4,
    sort_order: 4,
  },
  {
    slug: "branding",
    name_ar: "تصميم الهوية والمواد التسويقية",
    name_en: "Branding and marketing materials",
    short_ar: "هوية بصرية متكاملة وملفات جاهزة للاستخدام.",
    short_en: "A complete visual identity with ready-to-use files.",
    category: "brand",
    billing_type: "ONE_TIME",
    unit: "PROJECT",
    base_price_minor: 60_000,
    min_price_minor: 35_000,
    delivery_days: 14,
    revisions_included: 3,
    sort_order: 5,
  },
  {
    slug: "web-development",
    name_ar: "إنشاء وتطوير المواقع",
    name_en: "Website creation and development",
    short_ar: "موقع سريع ومتجاوب مع الهاتف، جاهز للعمل.",
    short_en: "A fast, mobile-first website ready to go live.",
    category: "web",
    billing_type: "ONE_TIME",
    unit: "PROJECT",
    base_price_minor: 120_000,
    min_price_minor: 70_000,
    delivery_days: 21,
    revisions_included: 3,
    sort_order: 6,
  },
  {
    slug: "seo",
    name_ar: "تحسين محركات البحث (SEO)",
    name_en: "Search engine optimisation (SEO)",
    short_ar: "تحسين الظهور في نتائج البحث بخطة واضحة وقياس مستمر.",
    short_en: "Improve search visibility with a clear plan and ongoing measurement.",
    category: "growth",
    billing_type: "SUBSCRIPTION",
    unit: "MONTH",
    base_price_minor: 35_000,
    min_price_minor: 20_000,
    delivery_days: 30,
    revisions_included: 2,
    sort_order: 7,
  },
  {
    slug: "analytics-reports",
    name_ar: "تحليل الأداء والتقارير",
    name_en: "Performance analysis and reporting",
    short_ar: "تقارير واضحة تشرح الأرقام بلغة مفهومة وقرارات مبنية عليها.",
    short_en: "Clear reports that explain the numbers and support decisions.",
    category: "analytics",
    billing_type: "SUBSCRIPTION",
    unit: "REPORT",
    base_price_minor: 15_000,
    min_price_minor: 9_000,
    delivery_days: 7,
    revisions_included: 2,
    sort_order: 8,
  },
  {
    slug: "consulting",
    name_ar: "الاستشارات والخطط التسويقية",
    name_en: "Consulting and marketing plans",
    short_ar: "جلسة استشارية أو خطة تسويقية مكتوبة قابلة للتنفيذ.",
    short_en: "A consulting session or a written, actionable marketing plan.",
    category: "consulting",
    billing_type: "ONE_TIME",
    unit: "PROJECT",
    base_price_minor: 20_000,
    min_price_minor: 12_000,
    delivery_days: 7,
    revisions_included: 1,
    sort_order: 9,
  },
];

type SettingType = "string" | "number" | "boolean";

/**
 * Default settings.
 *
 * These encode the commercial policy the platform starts with. The owner can
 * change every one of them from the dashboard; nothing here is a hard-coded rule.
 */
export const SEED_SETTINGS: [string, string | number | boolean, SettingType][] = [
  ["agency.name_ar", "أفق", "string"],
  ["agency.name_en", "Ofoq", "string"],
  ["agency.default_currency", "USD", "string"],
  ["agency.default_locale", "ar", "string"],
  ["agency.support_email", "", "string"],
  // The assistant may quote automatically inside these safety rails; anything
  // outside them is escalated to a human with the reason recorded.
  ["assistant.auto_quote", true, "boolean"],
  ["assistant.auto_approval_limit_minor", 150_000, "number"],
  ["assistant.max_discount_percent", 10, "number"],
  ["pricing.minimum_margin_percent", 25, "number"],
  ["pricing.escalation_threshold_minor", 500_000, "number"],
  ["reports.daily_enabled", true, "boolean"],
  ["reports.deep_on_request", true, "boolean"],
  ["features.demo_content_visible", true, "boolean"],
];

export interface BaselineSeedSummary {
  servicesCreated: number;
  servicesTotal: number;
  agents: number;
  settingsCreated: number;
}

export async function seedBaselineData(): Promise<BaselineSeedSummary> {
  const env = getEnv();
  const existing = await listServices();
  let servicesCreated = 0;

  for (const service of SEED_SERVICES) {
    if (existing.some((row) => row.slug === service.slug)) continue;
    await createService({
      ...service,
      currency: env.payments.defaultCurrency,
      complexity_factor: 1,
      is_active: 1,
      cancellation_policy: null,
    });
    servicesCreated += 1;
  }

  await seedOrUpdateAgentRows(
    AGENT_DEFINITIONS.map((definition, index) => ({
      key: definition.key,
      name_ar: definition.nameAr,
      name_en: definition.nameEn,
      category: definition.category,
      description_ar: definition.descriptionAr,
      description_en: definition.descriptionEn,
      sort_order: index,
    })),
  );

  let settingsCreated = 0;
  for (const [key, value, type] of SEED_SETTINGS) {
    const current = await getSetting(key);
    if (current) continue;
    await setSetting(key, value, { type });
    settingsCreated += 1;
  }

  return {
    servicesCreated,
    servicesTotal: SEED_SERVICES.length,
    agents: AGENT_DEFINITIONS.length,
    settingsCreated,
  };
}
