import type { Locale } from "@/lib/domain/types";

/**
 * Bilingual labels for every stored status.
 *
 * Statuses are stored in English codes (single source of truth) and rendered
 * through this table, so a new status can never leak a raw code into the UI —
 * `tests/labels.test.ts` fails if one is missing.
 */

type Entry = { ar: string; en: string };

const label = (ar: string, en: string) => ({ ar, en });

export function translateLabel(table: Record<string, Entry>, code: string, locale: Locale): string {
  const entry = table[code];
  if (!entry) return code.replace(/_/g, " ");
  return locale === "ar" ? entry.ar : entry.en;
}

export const PROJECT_STATUS: Record<string, Entry> = {
  DRAFT: label("مسودة", "Draft"),
  // Stage names from the required client journey.
  NEW_REQUEST: label("طلب جديد", "New request"),
  NEEDS_ANALYSIS: label("تحليل الاحتياج", "Needs analysis"),
  OFFER_PREP: label("إعداد العرض", "Offer preparation"),
  AWAITING_APPROVAL: label("بانتظار موافقتك", "Awaiting your approval"),
  AWAITING_PAYMENT: label("بانتظار الدفع", "Awaiting payment"),
  PLANNING: label("التخطيط", "Planning"),
  IN_PROGRESS: label("قيد التنفيذ", "In progress"),
  IN_REVIEW: label("بانتظار مراجعتك", "Awaiting your review"),
  REVISIONS: label("تعديلات مطلوبة", "Revisions requested"),
  COMPLETED: label("مكتمل", "Completed"),
  CANCELLED: label("ملغى", "Cancelled"),
};

/** The ordered stages shown on the client project timeline. */
export const PROJECT_STAGE_ORDER: string[] = [
  "NEW_REQUEST",
  "NEEDS_ANALYSIS",
  "OFFER_PREP",
  "AWAITING_APPROVAL",
  "AWAITING_PAYMENT",
  "PLANNING",
  "IN_PROGRESS",
  "IN_REVIEW",
  "REVISIONS",
  "COMPLETED",
  "CANCELLED",
];

export const TASK_STATUS: Record<string, Entry> = {
  TODO: label("لم تبدأ", "Not started"),
  IN_PROGRESS: label("قيد العمل", "In progress"),
  BLOCKED: label("متعطلة", "Blocked"),
  REVIEW: label("بانتظار المراجعة", "In review"),
  DONE: label("مكتملة", "Done"),
};

export const OFFER_STATUS: Record<string, Entry> = {
  DRAFT: label("قيد الإعداد", "Being prepared"),
  SENT: label("بانتظار قرارك", "Awaiting your decision"),
  APPROVED: label("تمت الموافقة", "Approved"),
  REJECTED: label("مرفوض", "Declined"),
  EXPIRED: label("منتهي", "Expired"),
  CANCELLED: label("ملغى", "Cancelled"),
};

export const INVOICE_STATUS: Record<string, Entry> = {
  DRAFT: label("مسودة", "Draft"),
  ISSUED: label("صادرة", "Issued"),
  PARTIALLY_PAID: label("مدفوعة جزئيًا", "Partially paid"),
  PAID: label("مدفوعة", "Paid"),
  OVERDUE: label("متأخرة", "Overdue"),
  CANCELLED: label("ملغاة", "Cancelled"),
  REFUNDED: label("مُستردّة", "Refunded"),
};

export const PAYMENT_STATUS: Record<string, Entry> = {
  PENDING: label("قيد الانتظار", "Pending"),
  SUCCEEDED: label("ناجحة", "Successful"),
  FAILED: label("فاشلة", "Failed"),
  REFUNDED: label("مُستردّة", "Refunded"),
};

export const PAYMENT_METHOD: Record<string, Entry> = {
  MANUAL_TRANSFER: label("تحويل يدوي", "Manual transfer"),
  CASH: label("نقدًا", "Cash"),
  CARD_ONLINE: label("بطاقة عبر الإنترنت", "Card online"),
  WALLET: label("محفظة إلكترونية", "E-wallet"),
  OTHER: label("أخرى", "Other"),
};

export const SUBSCRIPTION_STATUS: Record<string, Entry> = {
  ACTIVE: label("نشط", "Active"),
  PAST_DUE: label("متأخر الدفع", "Past due"),
  PAUSED: label("متوقف مؤقتًا", "Paused"),
  CANCELLED: label("ملغى", "Cancelled"),
  EXPIRED: label("منتهي", "Expired"),
};

export const CUSTOMER_STATUS: Record<string, Entry> = {
  LEAD: label("مهتم", "Lead"),
  ACTIVE: label("عميل نشط", "Active client"),
  PAUSED: label("متوقف", "Paused"),
  ARCHIVED: label("مؤرشف", "Archived"),
};

export const CAMPAIGN_STATUS: Record<string, Entry> = {
  DRAFT: label("مسودة", "Draft"),
  PENDING_APPROVAL: label("بانتظار الموافقة", "Pending approval"),
  ACTIVE: label("نشطة", "Active"),
  PAUSED: label("متوقفة مؤقتًا", "Paused"),
  COMPLETED: label("منتهية", "Completed"),
  ARCHIVED: label("مؤرشفة", "Archived"),
};

export const AD_PLAN_STATUS: Record<string, Entry> = {
  DRAFT: label("مسودة", "Draft"),
  AWAITING_APPROVAL: label("بانتظار موافقة المالك", "Awaiting owner approval"),
  APPROVED: label("معتمدة", "Approved"),
  SUPERSEDED: label("نسخة سابقة", "Superseded"),
};

export const SYNC_STATUS: Record<string, Entry> = {
  NOT_CONNECTED: label("غير مرتبطة بحساب إعلاني", "Not connected to an ads account"),
  PENDING: label("بانتظار المزامنة", "Waiting to sync"),
  SYNCED: label("متزامنة", "Synced"),
  ERROR: label("خطأ في المزامنة", "Sync error"),
};

export const ALERT_SEVERITY: Record<string, Entry> = {
  URGENT: label("عاجل", "Urgent"),
  IMPORTANT: label("مهم", "Important"),
  INFO: label("معلومة", "Info"),
};

export const ALERT_STATUS: Record<string, Entry> = {
  OPEN: label("مفتوح", "Open"),
  ACKNOWLEDGED: label("تم الاطلاع", "Acknowledged"),
  RESOLVED: label("تمت المعالجة", "Resolved"),
};

export const REVIEW_STATUS: Record<string, Entry> = {
  PENDING: label("بانتظار المراجعة", "Awaiting review"),
  APPROVED: label("معتمد للنشر", "Approved for publishing"),
  REJECTED: label("غير منشور", "Not published"),
  HIDDEN: label("مخفي", "Hidden"),
};

export const AGENT_STATUS: Record<string, Entry> = {
  ACTIVE: label("يعمل", "Working"),
  PAUSED: label("متوقف مؤقتًا", "Paused"),
  DISABLED: label("معطّل", "Disabled"),
};

export const RISK_LEVEL: Record<string, Entry> = {
  LOW: label("مخاطر منخفضة", "Low risk"),
  MEDIUM: label("مخاطر متوسطة", "Medium risk"),
  HIGH: label("مخاطر عالية", "High risk"),
};

export const SERVICE_UNIT: Record<string, Entry> = {
  PROJECT: label("مشروع", "project"),
  MONTH: label("شهر", "month"),
  POST: label("منشور", "post"),
  DESIGN: label("تصميم", "design"),
  CAMPAIGN: label("حملة", "campaign"),
  HOUR: label("ساعة", "hour"),
  REPORT: label("تقرير", "report"),
};

export const BILLING_TYPE: Record<string, Entry> = {
  ONE_TIME: label("مرة واحدة", "One-time"),
  SUBSCRIPTION: label("اشتراك شهري", "Monthly subscription"),
};

export const INTEGRATION_STATE: Record<string, Entry> = {
  connected: label("مُفعّل", "Connected"),
  available: label("جاهز للربط", "Ready to connect"),
  not_connected: label("غير مربوط", "Not connected"),
  disabled: label("مُعطّل", "Disabled"),
  error: label("خطأ", "Error"),
};

/** Human names for internal agent keys (staff surfaces only). */
export const AGENT_LABELS: Record<string, Entry> = {
  orchestrator: label("المنسّق (مساعد أفق)", "Orchestrator (Ofoq assistant)"),
  needs_analyst: label("محلّل الاحتياج", "Needs analyst"),
  pricing_advisor: label("مستشار التسعير", "Pricing advisor"),
  proposal_writer: label("مُعدّ العروض", "Offer writer"),
  project_manager: label("مدير المشاريع", "Project manager"),
  content_creator: label("صانع المحتوى", "Content creator"),
  ads_manager: label("مدير الإعلانات", "Ads manager"),
  google_ads_specialist: label("أخصائي Google Ads", "Google Ads specialist"),
  seo_specialist: label("أخصائي SEO", "SEO specialist"),
  report_writer: label("كاتب التقارير", "Report writer"),
  customer_support: label("دعم العملاء", "Customer support"),
  translator: label("المترجم", "Translator"),
  satisfaction_analyst: label("محلّل الرضا", "Satisfaction analyst"),
};

export function statusLabel(code: string, locale: Locale): string {
  const tables = [
    PROJECT_STATUS,
    TASK_STATUS,
    OFFER_STATUS,
    INVOICE_STATUS,
    PAYMENT_STATUS,
    SUBSCRIPTION_STATUS,
    CUSTOMER_STATUS,
    CAMPAIGN_STATUS,
    SYNC_STATUS,
    ALERT_SEVERITY,
    ALERT_STATUS,
    REVIEW_STATUS,
    AGENT_STATUS,
    SERVICE_UNIT,
    BILLING_TYPE,
    RISK_LEVEL,
  ];
  for (const table of tables) {
    if (table[code]) return table[code]![locale];
  }
  return code.replace(/_/g, " ");
}
