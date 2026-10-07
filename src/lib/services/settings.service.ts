import { DEFAULT_CURRENCY, isSupportedCurrency } from "@/lib/core/money";
import type { Locale } from "@/lib/domain/types";
import { getSettingValue, listSettings, setSetting } from "@/lib/repositories/governance.repo";

/**
 * Settings.
 *
 * Commercial policy (who may auto-approve a price, how big a discount is
 * acceptable, the minimum margin, how long an invoice stays open) lives in the
 * database — never in code — so the owner can change it without a deploy and
 * every change is auditable.
 *
 * Two shapes are exposed on purpose:
 *  - flat, client-facing policy fields (`cancellationPolicyAr`, `taxPercent`, …)
 *    used by offers, invoices, subscriptions and the assistant, and
 *  - grouped fields (`assistant.*`, `pricing.*`, `reports.*`) used by the agents.
 */

export interface AgencySettings {
  nameAr: string;
  nameEn: string;
  defaultCurrency: string;
  defaultLocale: Locale;
  supportEmail: string;
  /** Sales tax applied to invoices, in percent. 0 means "no tax configured". */
  taxPercent: number;
  /** Days between issuing an invoice and its due date. */
  invoiceDueDays: number;
  /** Policy text shown to the client BEFORE any payment (bilingual). */
  cancellationPolicyAr: string;
  cancellationPolicyEn: string;
  refundPolicyAr: string;
  refundPolicyEn: string;
  dailyReportEnabled: boolean;
  deepReportOnRequest: boolean;
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
  taxPercent: "billing.tax_percent",
  invoiceDueDays: "billing.invoice_due_days",
  cancellationPolicyAr: "policy.cancellation_ar",
  cancellationPolicyEn: "policy.cancellation_en",
  refundPolicyAr: "policy.refund_ar",
  refundPolicyEn: "policy.refund_en",
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

/**
 * Default policies.
 *
 * These are the agency's own wording for the rules the brief sets: cancelling
 * stops the next renewal and the service runs to the end of the paid period;
 * refunds are reviewed against how much work has actually been delivered; ad
 * spend already paid to a platform is not refundable; anything exceptional goes
 * to the owner/partner. They are editable from the dashboard.
 */
export const DEFAULT_POLICIES = {
  cancellationAr:
    "يمكنك طلب إلغاء الاشتراك من حسابك في أي وقت. الإلغاء يوقف التجديد التالي، وتستمر الخدمة حتى نهاية المدة المدفوعة. لا تُخصم أي مبالغ إضافية بعد الإلغاء.",
  cancellationEn:
    "You can request cancellation from your account at any time. Cancelling stops the next renewal and the service continues until the end of the paid period. No further charges are made after cancellation.",
  refundAr:
    "يمكن الاسترجاع الكامل إذا لم يبدأ التنفيذ. بعد بدء التنفيذ يُحسب الاسترجاع حسب العمل المُنجز فعليًا. المبالغ المصروفة فعليًا على منصات الإعلانات غير قابلة للاسترجاع. الحالات الاستثنائية تُراجع من المالك أو الشريك، ويصلك القرار مع السبب.",
  refundEn:
    "A full refund is available if no work has started. Once delivery begins, refunds are calculated against the work actually completed. Ad spend already paid to advertising platforms is not refundable. Exceptional cases are reviewed by the owner or a partner, and you receive the decision with its reason.",
} as const;

export async function getAgencySettings(): Promise<AgencySettings> {
  const locale = await getSettingValue<string>(SETTING_KEYS.defaultLocale, "ar");
  const currency = await getSettingValue<string>(SETTING_KEYS.defaultCurrency, DEFAULT_CURRENCY);

  const dailyReportEnabled = await getSettingValue(SETTING_KEYS.reportsDaily, true);
  const deepReportOnRequest = await getSettingValue(SETTING_KEYS.reportsDeepOnRequest, true);
  const assistantAutoApprovalLimit = await getSettingValue(SETTING_KEYS.assistantAutoApprovalLimit, 150_000);

  return {
    nameAr: await getSettingValue(SETTING_KEYS.nameAr, "أفق"),
    nameEn: await getSettingValue(SETTING_KEYS.nameEn, "Ofoq"),
    defaultCurrency: isSupportedCurrency(currency) ? currency : DEFAULT_CURRENCY,
    defaultLocale: locale === "en" ? "en" : "ar",
    supportEmail: await getSettingValue(SETTING_KEYS.supportEmail, "hello@ofaq.com"),

    taxPercent: await getSettingValue(SETTING_KEYS.taxPercent, 0),
    invoiceDueDays: await getSettingValue(SETTING_KEYS.invoiceDueDays, 7),
    cancellationPolicyAr: await getSettingValue(SETTING_KEYS.cancellationPolicyAr, DEFAULT_POLICIES.cancellationAr),
    cancellationPolicyEn: await getSettingValue(SETTING_KEYS.cancellationPolicyEn, DEFAULT_POLICIES.cancellationEn),
    refundPolicyAr: await getSettingValue(SETTING_KEYS.refundPolicyAr, DEFAULT_POLICIES.refundAr),
    refundPolicyEn: await getSettingValue(SETTING_KEYS.refundPolicyEn, DEFAULT_POLICIES.refundEn),
    dailyReportEnabled,
    deepReportOnRequest,

    assistant: {
      autoQuote: await getSettingValue(SETTING_KEYS.assistantAutoQuote, true),
      autoApprovalLimitMinor: assistantAutoApprovalLimit,
      maxDiscountPercent: await getSettingValue(SETTING_KEYS.assistantMaxDiscount, 10),
    },
    pricing: {
      minimumMarginPercent: await getSettingValue(SETTING_KEYS.pricingMinimumMargin, 25),
      escalationThresholdMinor: await getSettingValue(SETTING_KEYS.pricingEscalationThreshold, 500_000),
      internalCostRatio: await getSettingValue(SETTING_KEYS.pricingInternalCostRatio, 0.55),
    },
    reports: {
      dailyEnabled: dailyReportEnabled,
      deepOnRequest: deepReportOnRequest,
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
  options: { type?: "string" | "number" | "boolean" | "json"; updatedBy?: string | null; note?: string } = {},
): Promise<void> {
  await setSetting(key, value, { type: options.type, updatedBy: options.updatedBy ?? null });
  const { logActivity } = await import("./activity.service");
  await logActivity({
    actor_type: options.updatedBy ? "USER" : "SYSTEM",
    actor_user_id: options.updatedBy ?? null,
    action: "settings.updated",
    entity_type: "setting",
    entity_id: key,
    summary: `تحديث إعداد: ${key}${options.note ? ` — ${options.note}` : ""}`,
    meta: { key, value: options.type === "json" ? undefined : value, note: options.note },
  });
}

export async function allSettings() {
  return listSettings();
}
