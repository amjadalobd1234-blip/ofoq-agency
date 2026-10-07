import { DEFAULT_CURRENCY, isSupportedCurrency } from "@/lib/core/money";
import type { Locale } from "@/lib/domain/types";
import { getSettingValue, listSettings, setSetting } from "@/lib/repositories/governance.repo";

/**
 * Settings.
 *
 * Commercial policy (who may auto-approve a price, how big a discount is
 * acceptable, the minimum margin) lives in the database — never in code — so the
 * owner can change it without a deploy, and so every change is auditable.
 */

export interface AgencySettings {
  nameAr: string;
  nameEn: string;
  defaultCurrency: string;
  defaultLocale: Locale;
  supportEmail: string;
  assistant: {
    autoQuote: boolean;
    /** Quotes at or below this total may be approved automatically. */
    autoApprovalLimitMinor: number;
    /** Discounts above this percentage always need a human. */
    maxDiscountPercent: number;
  };
  pricing: {
    minimumMarginPercent: number;
    /** Totals above this always need a human, whatever else is true. */
    escalationThresholdMinor: number;
    /** Internal cost assumption when a service has no cost data yet. */
    internalCostRatio: number;
  };
  reports: {
    dailyEnabled: boolean;
    deepOnRequest: boolean;
  };
  features: {
    demoContentVisible: boolean;
  };
}

export const SETTING_KEYS = {
  nameAr: "agency.name_ar",
  nameEn: "agency.name_en",
  defaultCurrency: "agency.default_currency",
  defaultLocale: "agency.default_locale",
  supportEmail: "agency.support_email",
  assistantAutoQuote: "assistant.auto_quote",
  assistantAutoApprovalLimit: "assistant.auto_approval_limit_minor",
  assistantMaxDiscount: "assistant.max_discount_percent",
  pricingMinimumMargin: "pricing.minimum_margin_percent",
  pricingEscalationThreshold: "pricing.escalation_threshold_minor",
  pricingInternalCostRatio: "pricing.internal_cost_ratio",
  reportsDaily: "reports.daily_enabled",
  reportsDeepOnRequest: "reports.deep_on_request",
  demoContentVisible: "features.demo_content_visible",
} as const;

export async function getAgencySettings(): Promise<AgencySettings> {
  const locale = await getSettingValue<string>(SETTING_KEYS.defaultLocale, "ar");
  const currency = await getSettingValue<string>(SETTING_KEYS.defaultCurrency, DEFAULT_CURRENCY);

  return {
    nameAr: await getSettingValue(SETTING_KEYS.nameAr, "أفق"),
    nameEn: await getSettingValue(SETTING_KEYS.nameEn, "Ofoq"),
    defaultCurrency: isSupportedCurrency(currency) ? currency : DEFAULT_CURRENCY,
    defaultLocale: locale === "en" ? "en" : "ar",
    supportEmail: await getSettingValue(SETTING_KEYS.supportEmail, "hello@ofaq.com"),
    assistant: {
      autoQuote: await getSettingValue(SETTING_KEYS.assistantAutoQuote, true),
      autoApprovalLimitMinor: await getSettingValue(SETTING_KEYS.assistantAutoApprovalLimit, 150_000),
      maxDiscountPercent: await getSettingValue(SETTING_KEYS.assistantMaxDiscount, 10),
    },
    pricing: {
      minimumMarginPercent: await getSettingValue(SETTING_KEYS.pricingMinimumMargin, 25),
      escalationThresholdMinor: await getSettingValue(SETTING_KEYS.pricingEscalationThreshold, 500_000),
      internalCostRatio: await getSettingValue(SETTING_KEYS.pricingInternalCostRatio, 0.55),
    },
    reports: {
      dailyEnabled: await getSettingValue(SETTING_KEYS.reportsDaily, true),
      deepOnRequest: await getSettingValue(SETTING_KEYS.reportsDeepOnRequest, true),
    },
    features: {
      demoContentVisible: await getSettingValue(SETTING_KEYS.demoContentVisible, true),
    },
  };
}

export async function readSetting<T>(key: string, fallback: T): Promise<T> {
  return getSettingValue<T>(key, fallback);
}

export async function writeSetting(
  key: string,
  value: unknown,
  options: { type?: "string" | "number" | "boolean" | "json"; updatedBy?: string | null; internalNote?: string } = {},
): Promise<void> {
  await setSetting(key, value, { type: options.type, updatedBy: options.updatedBy ?? null });
  if (options.internalNote) {
    const { logActivity } = await import("./activity.service");
    await logActivity({
      actor_type: options.updatedBy ? "USER" : "SYSTEM",
      actor_user_id: options.updatedBy ?? null,
      action: "settings.updated",
      entity_type: "setting",
      entity_id: key,
      summary_ar: `تحديث إعداد: ${key}`,
      summary_en: `Setting updated: ${key}`,
      meta: { key, value, note: options.internalNote },
    });
  }
}

export async function allSettings() {
  return listSettings();
}
