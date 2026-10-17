import { resolveLocale, t } from "@/lib/ai/language";
import { formatMoney } from "@/lib/core/money";
import type { CustomerRow, Locale } from "@/lib/domain/types";
import { listInvoices, listSubscriptions } from "@/lib/repositories/billing.repo";
import { listProjects } from "@/lib/repositories/projects.repo";
import { listOffers } from "@/lib/repositories/offers.repo";
import { getAgencySettings } from "@/lib/services/settings.service";
import { explainMetric, glossary } from "./reports.agent";

import { runAgent } from "../runtime";

/**
 * Customer support agent.
 *
 * Answers questions from a deterministic knowledge base built from the client's
 * OWN data (their projects, offers, invoices, subscriptions) plus the agency's
 * published policies. It never invents statuses, never promises money, and
 * escalates anything it cannot answer confidently to a human — which is exactly
 * what the platform rules require.
 */
export type SupportIntent =
  | "GREETING"
  | "PROJECT_STATUS"
  | "OFFER_QUESTION"
  | "BILLING_QUESTION"
  | "SUBSCRIPTION_QUESTION"
  | "REPORT_QUESTION"
  | "DEEP_REPORT_REQUEST"
  | "PRICING_QUESTION"
  | "POLICY_QUESTION"
  | "COMPLAINT"
  | "HUMAN_REQUEST"
  | "SERVICE_QUESTION"
  | "UNKNOWN";

export interface SupportAnswer {
  intent: SupportIntent;
  text: string;
  quickReplies: string[];
  escalate: boolean;
  escalationReason?: string;
}

export function classifyIntent(message: string): SupportIntent {
  const text = message.toLowerCase();
  if (/^(hi|hello|hey|مرحبا|مرحبًا|السلام|اهلا|أهلًا|هاي)\b/.test(text.trim())) return "GREETING";
  if (/(تفاصيل أكثر|more details|تفاصيل اكثر|deep report|تقرير مفصّل|تقرير مفصل)/.test(text)) {
    return "DEEP_REPORT_REQUEST";
  }
  if (/(مشروع|project|حالة|status|وين وصلت|اين وصلت|تقدم|progress)/.test(text)) return "PROJECT_STATUS";
  if (/(عرض|offer|proposal|موافقة|approve|عقد)/.test(text)) return "OFFER_QUESTION";
  // A price question is a sales question, not a billing one — check it first.
  if (/(كم سعر|كم يكلف|pricing|أسعار|اسعار|تسعير|عرض سعر|عرض سعري|price list|quote)/.test(text)) {
    return "PRICING_QUESTION";
  }
  if (/(اشتراك|subscription|تجديد|renew|إلغاء الاشتراك|cancel)/.test(text)) return "SUBSCRIPTION_QUESTION";
  if (/(تقرير|report|أرقام|numbers|نتائج الحملة|campaign)/.test(text)) return "REPORT_QUESTION";
  if (/(فاتورة|invoice|دفع|payment)/.test(text)) return "BILLING_QUESTION";
  if (/(سياسة|policy|استرجاع|refund|إلغاء|تنازل)/.test(text)) return "POLICY_QUESTION";
  if (/(شكوى|مشكلة|غير راضي|مو راضي|زعلان|complaint|angry|upset|disappointed|bad service)/.test(text)) {
    return "COMPLAINT";
  }
  if (/(موظف|بشري|انسان|إنسان|human|agent person|كلمني|اتصل بي|call me)/.test(text)) return "HUMAN_REQUEST";
  if (/(خدمة|services?|باقة|package|ماذا تقدمون|what do you do)/.test(text)) return "SERVICE_QUESTION";
  if (/(impressions|clicks|ctr|cpc|cpa|ظهور|نقرات|نقرة|تحويلات)/.test(text)) return "REPORT_QUESTION";
  return "UNKNOWN";
}

export interface SupportContext {
  locale: Locale;
  /** The client's own data, already scoped by the caller. */
  projects?: { code: string; title: string; status: string; progress: number; dueDate: string | null }[];
  offers?: { code: string; status: string; totalMinor: number | null; currency: string }[];
  invoices?: { number: string; status: string; totalMinor: number; paidMinor: number; currency: string; dueDate: string | null }[];
  subscriptions?: { planName: string; status: string; amountMinor: number; currency: string; nextRenewal: string | null; cancelAtPeriodEnd: boolean }[];
  lastReportTitle?: string | null;
}

/** Loads the client's own data for the assistant (never other clients'). */
export async function loadSupportContext(customer: CustomerRow): Promise<SupportContext> {
  const [projects, offers, invoices, subscriptions] = await Promise.all([
    listProjects({ customerId: customer.id, limit: 5 }),
    listOffers({ customerId: customer.id, limit: 5 }),
    listInvoices({ customerId: customer.id, limit: 10 }),
    listSubscriptions({ customerId: customer.id, limit: 5 }),
  ]);

  return {
    locale: customer.locale,
    projects: projects.rows.map((project) => ({
      code: project.code,
      title: project.title,
      status: project.status,
      progress: project.progress,
      dueDate: project.due_date,
    })),
    offers: offers.rows.map((offer) => ({
      code: offer.code,
      status: offer.status,
      totalMinor: offer.total_minor,
      currency: offer.currency,
    })),
    invoices: invoices.rows.map((invoice) => ({
      number: invoice.number,
      status: invoice.status,
      totalMinor: invoice.total_minor,
      paidMinor: invoice.amount_paid_minor,
      currency: invoice.currency,
      dueDate: invoice.due_at,
    })),
    subscriptions: subscriptions.rows.map((subscription) => ({
      planName: subscription.plan_name,
      status: subscription.status,
      amountMinor: subscription.amount_minor,
      currency: subscription.currency,
      nextRenewal: subscription.next_renewal_at,
      cancelAtPeriodEnd: subscription.cancel_at_period_end === 1,
    })),
  };
}

export async function answerSupportQuestion(input: {
  customer: CustomerRow;
  message: string;
  context?: SupportContext;
  conversationId?: string | null;
}): Promise<SupportAnswer> {
  const locale = resolveLocale(input.message, input.customer.locale);
  const intent = classifyIntent(input.message);
  const context = input.context ?? (await loadSupportContext(input.customer));
  const answer = await composeAnswer({ intent, locale, context, message: input.message, customer: input.customer });

  const outcome = await runAgent(
    "customer_support",
    {
      trigger: "chat.message",
      locale,
      customerId: input.customer.id,
      conversationId: input.conversationId ?? null,
      input: { intent },
    },
    async ({ record }) => {
      record({
        action: answer.escalate ? "escalated" : "answered",
        summary: answer.escalate
          ? `تم تصعيد استفسار (${intent}) إلى الفريق البشري`
          : `أُجيب على استفسار العميل (${intent})`,
        reason: answer.escalationReason,
        riskLevel: "LOW",
        requiresApproval: answer.escalate,
        entityType: "customer",
        entityId: input.customer.id,
      });
      return {
        data: { intent, escalate: answer.escalate },
        summary: answer.escalate ? `تصعيد: ${intent}` : `إجابة: ${intent}`,
        riskLevel: "LOW",
      };
    },
  );
  void outcome;

  return answer;
}

async function composeAnswer(input: {
  intent: SupportIntent;
  locale: Locale;
  context: SupportContext;
  message: string;
  customer: CustomerRow;
}): Promise<SupportAnswer> {
  const { intent, locale, context } = input;
  const isAr = locale === "ar";
  const settings = await getAgencySettings();

  switch (intent) {
    case "GREETING":
      return {
        intent,
        text: isAr
          ? "أهلًا بك 👋 أنا مساعد أفق. أستطيع أن أخبرك بحالة مشاريعك، أو أوضّح الفواتير والاشتراكات، أو أجهّز لك عرضًا جديدًا."
          : "Welcome back 👋 I'm the Ofoq assistant. I can show your project status, explain invoices and subscriptions, or prepare a new offer.",
        quickReplies: isAr
          ? ["حالة مشاريعي", "الفواتير", "أريد خدمة جديدة", "تفاصيل أكثر"]
          : ["My project status", "Invoices", "I need a new service", "More details"],
        escalate: false,
      };

    case "PROJECT_STATUS": {
      if (!context.projects || context.projects.length === 0) {
        return {
          intent,
          text: isAr
            ? "لا يوجد مشروع مسجّل على حسابك حتى الآن. أخبرني بما تحتاجه وأبدأ فورًا بإعداد عرض."
            : "No project is registered on your account yet. Tell me what you need and I'll prepare an offer right away.",
          quickReplies: isAr ? ["أريد خدمة جديدة"] : ["I need a new service"],
          escalate: false,
        };
      }
      const lines = context.projects.map((project) => {
        const status = translateStatus(project.status, locale);
        return isAr
          ? `• ${project.code} — ${project.title}: ${status} (${project.progress}%)${project.dueDate ? `، التسليم ${project.dueDate.slice(0, 10)}` : ""}`
          : `• ${project.code} — ${project.title}: ${status} (${project.progress}%)${project.dueDate ? `, due ${project.dueDate.slice(0, 10)}` : ""}`;
      });
      return {
        intent,
        text: isAr
          ? `هذا ملخص مشاريعك الحالية:\n${lines.join("\n")}\n\nيمكنك فتح أي مشروع من «مشاريعي» لرؤية المراحل والمهام.`
          : `Here is a summary of your current projects:\n${lines.join("\n")}\n\nOpen any project in "My projects" to see phases and tasks.`,
        quickReplies: isAr ? ["تفاصيل أكثر", "تحدث مع الفريق"] : ["More details", "Talk to the team"],
        escalate: false,
      };
    }

    case "OFFER_QUESTION": {
      if (!context.offers || context.offers.length === 0) {
        return {
          intent,
          text: isAr
            ? "لا يوجد عرض حالي على حسابك. إذا أخبرتني بخدمتك المطلوبة أجهّز لك عرضًا واضحًا بالسعر والمدة."
            : "You have no current offer. Tell me the service you need and I'll prepare a clear offer with price and timeline.",
          quickReplies: isAr ? ["أريد خدمة جديدة"] : ["I need a new service"],
          escalate: false,
        };
      }
      const lines = context.offers.map((offer) => {
        const price = offer.totalMinor === null
          ? isAr ? "يحتاج مراجعة" : "Needs review"
          : formatMoney(offer.totalMinor, offer.currency, locale);
        return `• ${offer.code} — ${translateStatus(offer.status, locale)} — ${price}`;
      });
      return {
        intent,
        text: isAr
          ? `العروض على حسابك:\n${lines.join("\n")}\n\nيمكنك مراجعة أي عرض والموافقة عليه أو طلب تعديل من صفحة «العروض».`
          : `Your offers:\n${lines.join("\n")}\n\nReview, approve or request changes from the "Offers" page.`,
        quickReplies: isAr ? ["سياسة الإلغاء والاسترجاع"] : ["Cancellation and refund policy"],
        escalate: false,
      };
    }

    case "BILLING_QUESTION": {
      if (!context.invoices || context.invoices.length === 0) {
        return {
          intent,
          text: isAr
            ? "لا توجد فواتير على حسابك. عند الموافقة على عرض تُصدر فاتورة تلقائيًا وتظهر هنا."
            : "You have no invoices. Approving an offer issues an invoice automatically and it appears here.",
          quickReplies: [],
          escalate: false,
        };
      }
      const outstanding = context.invoices.filter((invoice) =>
        ["ISSUED", "OVERDUE", "PARTIALLY_PAID"].includes(invoice.status),
      );
      const lines = context.invoices
        .slice(0, 5)
        .map(
          (invoice) =>
            `• ${invoice.number} — ${translateStatus(invoice.status, locale)} — ${formatMoney(
              invoice.totalMinor - invoice.paidMinor,
              invoice.currency,
              locale,
            )} ${isAr ? "متبقي" : "remaining"}`,
        );
      return {
        intent,
        text: isAr
          ? `${lines.join("\n")}${
              outstanding.length > 0
                ? `\n\nالمطلوب حاليًا: ${formatMoney(
                    outstanding.reduce((total, invoice) => total + (invoice.totalMinor - invoice.paidMinor), 0),
                    outstanding[0]!.currency,
                    locale,
                  )}.\nيمكنك السداد بتحويل بنكي أو دفع نقدي، ثم يسجّله الفريق على الفاتورة.`
                : "\n\nلا توجد مبالغ مستحقة حاليًا."
            }\n\n🔒 لن أطلب منك أبدًا بيانات بطاقتك.`
          : `${lines.join("\n")}${
              outstanding.length > 0
                ? `\n\nOutstanding: ${formatMoney(
                    outstanding.reduce((total, invoice) => total + (invoice.totalMinor - invoice.paidMinor), 0),
                    outstanding[0]!.currency,
                    locale,
                  )}.\nYou can settle by transfer or cash; the team records it against the invoice.`
                : "\n\nNothing is outstanding right now."
            }\n\n🔒 I will never ask for your card details.`,
        quickReplies: isAr ? ["سياسة الاسترجاع"] : ["Refund policy"],
        escalate: false,
      };
    }

    case "SUBSCRIPTION_QUESTION": {
      if (!context.subscriptions || context.subscriptions.length === 0) {
        return {
          intent,
          text: isAr
            ? "لا يوجد اشتراك فعّال على حسابك. الاشتراكات الشهرية متاحة لإدارة التواصل الاجتماعي وSEO وإدارة الإعلانات والتقارير المستمرة."
            : "You have no active subscription. Monthly plans are available for social media management, SEO, ads management and ongoing reporting.",
          quickReplies: isAr
            ? ["أريد إدارة حسابات التواصل", "أريد إدارة الإعلانات"]
            : ["Social media management", "Ads management"],
          escalate: false,
        };
      }
      const lines = context.subscriptions.map((subscription) => {
        const renewal = subscription.cancelAtPeriodEnd
          ? isAr
            ? "يتوقف التجديد في نهاية الفترة المدفوعة"
            : "Renewal stops at the end of the paid period"
          : subscription.nextRenewal
            ? isAr
              ? `التجديد التالي ${subscription.nextRenewal.slice(0, 10)}`
              : `Next renewal ${subscription.nextRenewal.slice(0, 10)}`
            : isAr
              ? "بدون تجديد تلقائي"
              : "No automatic renewal";
        return `• ${subscription.planName} — ${translateStatus(subscription.status, locale)} — ${formatMoney(
          subscription.amountMinor,
          subscription.currency,
          locale,
        )} — ${renewal}`;
      });
      return {
        intent,
        text: isAr
          ? `اشتراكاتك:\n${lines.join("\n")}\n\nعند طلب الإلغاء يتوقف التجديد التالي، وتستمر الخدمة حتى نهاية الفترة المدفوعة.`
          : `Your subscriptions:\n${lines.join("\n")}\n\nWhen you cancel, the next renewal stops and the service continues to the end of the paid period.`,
        quickReplies: isAr ? ["طلب إلغاء الاشتراك", "سياسة الاسترجاع"] : ["Request cancellation", "Refund policy"],
        escalate: false,
      };
    }

    case "REPORT_QUESTION":
    case "DEEP_REPORT_REQUEST": {
      const metricText = explainMetricMessage(input.message, locale);
      const base = isAr
        ? "التقارير موجودة في بوابة العميل: التقرير اليومي يشرح ماذا حدث، وكم تم إنفاقه، وما الذي عُدِّل. أي أرقام تُعرض كما هي مسجلة في النظام."
        : "Reports live in your portal: the daily report explains what happened, what was spent and what changed. Numbers are shown exactly as recorded in the system.";
      const deep = deepReportInvitation(locale, settings.deepReportOnRequest);
      return {
        intent,
        text: [base, metricText, deep].filter(Boolean).join("\n\n"),
        quickReplies: isAr ? ["تفاصيل أكثر", "تحدث مع الفريق"] : ["More details", "Talk to the team"],
        escalate: intent === "REPORT_QUESTION" && /مشكلة|غلط|غير صحيح|wrong|incorrect/.test(input.message),
        escalationReason: "A data discrepancy question needs a human to verify.",
      };
    }

    case "PRICING_QUESTION": {
      return {
        intent,
        text: isAr
          ? "أستطيع تسعير خدمتك فورًا بعد معرفة نوعها وحجمها والمدة والمنصات. أخبرني بالتفاصيل وسأعطيك سعرًا أوليًا ومدة تنفيذ، ويمكنك دائمًا طلب تعديل."
          : "I can price your service as soon as I know the type, scope, timeline and platforms. Share the details and I'll give you an initial price with a delivery estimate you can adjust.",
        quickReplies: isAr
          ? ["إدارة حسابات التواصل", "إعلانات مدفوعة", "تصميم هوية"]
          : ["Social media management", "Paid ads", "Branding"],
        escalate: false,
      };
    }

    case "POLICY_QUESTION": {
      const policy = isAr
        ? `${settings.cancellationPolicyAr}\n\n${settings.refundPolicyAr}`
        : `${settings.cancellationPolicyEn}\n\n${settings.refundPolicyEn}`;
      return {
        intent,
        text: `${policy}\n\n${
          isAr
            ? "الحالات الاستثنائية تُحوَّل إلى المالك أو الشريك، ولا يتخذ النظام قرار استرجاع تلقائيًا."
            : "Exceptional cases go to the owner or partner; the system never decides a refund on its own."
        }`,
        quickReplies: isAr ? ["تحدث مع الفريق"] : ["Talk to the team"],
        escalate: false,
      };
    }

    case "COMPLAINT":
      return {
        intent,
        text: isAr
          ? "أعتذر عن هذه التجربة. تنبيه: أنا مساعد ذكي، ولذلك حوّلت رسالتك الآن إلى فريق أفق البشري وسيتواصل معك شخص مسؤول قريبًا."
          : "I'm sorry about this experience. Note: I'm an AI assistant, so I have escalated your message to the Ofoq human team and a responsible person will contact you shortly.",
        quickReplies: [],
        escalate: true,
        escalationReason: "Client expressed dissatisfaction — human follow-up required.",
      };

    case "HUMAN_REQUEST":
      return {
        intent,
        text: t("humanHandoff", locale),
        quickReplies: [],
        escalate: true,
        escalationReason: "Client explicitly requested a human team member.",
      };

    case "SERVICE_QUESTION": {
      const services = isAr
        ? "نقدّم في أفق: إدارة حسابات التواصل الاجتماعي، كتابة وتصميم المنشورات، خطط المحتوى والنشر، إدارة الإعلانات المدفوعة، تصميم الهوية والمواد التسويقية، إنشاء وتطوير المواقع، تحسين محركات البحث SEO، تحليل الأداء والتقارير، والاستشارات والخطط التسويقية. يمكنك اختيار خدمة واحدة أو أكثر."
        : "Ofoq offers: social media management, post writing and design, content plans, paid ads management, branding and marketing materials, website development, SEO, performance analysis and reporting, and marketing consulting. You can pick one service or several.";
      return {
        intent,
        text: services,
        quickReplies: isAr
          ? ["أريد عرضًا سعريًا", "كيف تعملون؟"]
          : ["Get a quote", "How do you work?"],
        escalate: false,
      };
    }

    case "UNKNOWN":
    default:
      return {
        intent: "UNKNOWN",
        text: t("fallback", locale),
        quickReplies: isAr
          ? ["حالة مشاريعي", "الفواتير", "أريد خدمة جديدة", "تحدث مع الفريق"]
          : ["My project status", "Invoices", "I need a new service", "Talk to the team"],
        escalate: /(شكوى|مشكلة|مو راضي|complaint|angry)/i.test(input.message),
        escalationReason: "Unrecognised message with negative sentiment.",
      };
  }
}

function deepReportInvitation(locale: Locale, enabled: boolean): string {
  if (!enabled) return "";
  return t("deepReportOffer", locale);
}

function explainMetricMessage(message: string, locale: Locale): string {
  const lower = message.toLowerCase();
  for (const term of ["impressions", "clicks", "ctr", "cpc", "cpa", "conversions", "spend"]) {
    if (lower.includes(term)) return explainMetric(term, locale);
  }
  if (locale === "ar" && /(ظهور|نقرات|نقرة|تحويلات)/.test(message)) {
    const key = message.includes("نقرة") || message.includes("نقرات") ? "clicks" : "impressions";
    return explainMetric(key, locale);
  }
  return "";
}

/** Full glossary for the "explain the terms" request. */
export function supportGlossary(locale: Locale): string {
  return glossary(locale)
    .map((entry) => `• ${entry.text}`)
    .join("\n");
}

export function translateStatus(status: string, locale: Locale): string {
  const map: Record<string, { ar: string; en: string }> = {
    DRAFT: { ar: "مسودة", en: "draft" },
    AWAITING_APPROVAL: { ar: "بانتظار الموافقة", en: "awaiting approval" },
    AWAITING_PAYMENT: { ar: "بانتظار الدفع", en: "awaiting payment" },
    PLANNING: { ar: "التخطيط", en: "planning" },
    IN_PROGRESS: { ar: "قيد التنفيذ", en: "in progress" },
    IN_REVIEW: { ar: "بانتظار مراجعتك", en: "in review" },
    REVISIONS: { ar: "تعديلات", en: "revisions" },
    COMPLETED: { ar: "مكتمل", en: "completed" },
    CANCELLED: { ar: "ملغى", en: "cancelled" },
    SENT: { ar: "مُرسل", en: "sent" },
    APPROVED: { ar: "موافَق عليه", en: "approved" },
    REJECTED: { ar: "مرفوض", en: "rejected" },
    EXPIRED: { ar: "منتهي", en: "expired" },
    ISSUED: { ar: "صادرة", en: "issued" },
    PARTIALLY_PAID: { ar: "مدفوعة جزئيًا", en: "partially paid" },
    PAID: { ar: "مدفوعة", en: "paid" },
    OVERDUE: { ar: "متأخرة", en: "overdue" },
    REFUNDED: { ar: "مُسترجعة", en: "refunded" },
    ACTIVE: { ar: "فعّال", en: "active" },
    PAST_DUE: { ar: "متأخر", en: "past due" },
    PAUSED: { ar: "موقوف مؤقتًا", en: "paused" },
    NEW: { ar: "جديد", en: "new" },
    ACKNOWLEDGED: { ar: "تم الاطلاع", en: "acknowledged" },
    RESOLVED: { ar: "تم الحل", en: "resolved" },
  };
  const entry = map[status];
  if (!entry) return status;
  return locale === "ar" ? entry.ar : entry.en;
}

/** Ensures the assistant replies in the client's language when they switch. */
export function answerLanguage(message: string, fallback: Locale): Locale {
  const detected = resolveLocale(message, fallback);
  void detectLanguageQuiet(message);
  return detected;
}

function detectLanguageQuiet(message: string): void {
  void message;
}
