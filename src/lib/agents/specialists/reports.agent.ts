import type { CampaignRow, Locale } from "@/lib/domain/types";
import {
  buildDailyReportContent,
  buildProjectReport,
  sendDailyCampaignReport,
  sendDeepCampaignReport,
} from "@/lib/services/reports.service";

import { runAgent } from "../runtime";

/**
 * Reporting agent.
 *
 * Owns the wording and delivery of client reports. Two rules are enforced:
 *  1. client reports never contain internal costs, margins or other clients,
 *  2. every number is labelled with its source (measured today vs. not yet
 *     available), so a client is never shown an estimate as if it were a fact.
 */

export interface ReportRunOutcome {
  reportId: string | null;
  delivered: boolean;
  summary: string;
}

export async function runDailyCampaignReport(
  campaign: CampaignRow,
  dayKey: string,
  locale: Locale,
): Promise<ReportRunOutcome> {
  const content = await buildDailyReportContent(campaign, locale, dayKey);

  const result = await runAgent(
    "reporting",
    {
      trigger: "daily_job",
      locale,
      customerId: campaign.customer_id,
      input: { campaignId: campaign.id, dayKey },
    },
    async ({ record }) => {
      const sent = await sendDailyCampaignReport(campaign, dayKey);
      record({
        action: sent ? "report.sent" : "report.already_sent",
        summary: sent
          ? `أُرسل تقرير يومي لحملة ${campaign.name}`
          : `تقرير ${campaign.name} لهذا اليوم أُرسل مسبقًا`,
        entityType: "report",
        entityId: sent?.report.id ?? null,
        riskLevel: "LOW",
      });
      return {
        data: { reportId: sent?.report.id ?? null, delivered: sent?.delivered ?? false },
        summary: sent
          ? `تقرير يومي (${content.metrics.impressions ?? 0} ظهور)`
          : "لا يوجد تقرير جديد لليوم",
        riskLevel: "LOW",
      };
    },
  );

  return {
    reportId: result.data.reportId,
    delivered: result.data.delivered,
    summary: result.summary,
  };
}

export async function runDeepReport(input: {
  campaignId: string;
  actorUserId: string;
  locale: Locale;
  periodDays?: number;
}): Promise<ReportRunOutcome> {
  const result = await runAgent(
    "reporting",
    {
      trigger: "client.request",
      locale: input.locale,
      input: { campaignId: input.campaignId, periodDays: input.periodDays ?? 30 },
    },
    async ({ record }) => {
      const report = await sendDeepCampaignReport(
        input.campaignId,
        input.actorUserId,
        input.periodDays ?? 30,
      );
      record({
        action: "report.deep_sent",
        summary: "أُرسل تقرير مفصّل يشرح الأرقام والمصطلحات للعميل",
        entityType: "report",
        entityId: report.id,
        riskLevel: "LOW",
      });
      return {
        data: { reportId: report.id, delivered: true },
        summary: "تقرير مفصّل جاهز",
        riskLevel: "LOW",
      };
    },
  );

  return { reportId: result.data.reportId, delivered: true, summary: result.summary };
}

export async function runProjectReport(projectId: string, locale: Locale): Promise<ReportRunOutcome> {
  const result = await runAgent(
    "reporting",
    {
      trigger: "project.completed",
      locale,
      projectId,
      input: { projectId },
    },
    async ({ record }) => {
      const report = await buildProjectReport(projectId, locale);
      record({
        action: "report.project_created",
        summary: "تم إنشاء تقرير إنجاز المشروع",
        entityType: "report",
        entityId: report.id,
        riskLevel: "LOW",
      });
      return {
        data: { reportId: report.id, delivered: false },
        summary: "تقرير المشروع جاهز في بوابة العميل",
        riskLevel: "LOW",
      };
    },
  );

  return {
    reportId: result.data.reportId,
    delivered: false,
    summary: result.summary,
  };
}

/**
 * Explains a metric in plain language when a client asks "what does this mean?".
 * Deterministic dictionary first, so no external provider is required.
 */
export function explainMetric(metric: string, locale: Locale): string {
  const dictionary: Record<string, { ar: string; en: string }> = {
    impressions: {
      ar: "مرات الظهور تعني عدد المرات التي ظهر فيها إعلانك للناس. الرقم الكبير جيد، لكن الأهم هو عدد من ضغط عليه.",
      en: "Impressions are how many times your ad was shown. A high number is good, but clicks matter more.",
    },
    clicks: {
      ar: "النقرات هي عدد الناس الذين ضغطوا على إعلانك ووصلوا إلى صفحتك.",
      en: "Clicks are how many people tapped your ad and reached your page.",
    },
    ctr: {
      ar: "نسبة النقر (CTR) تعني: من كل ١٠٠ شخص رأى الإعلان، كم شخصًا ضغط. كلما ارتفعت كان الإعلان أوضح وأجذب.",
      en: "CTR means: out of every 100 people who saw the ad, how many clicked. Higher means clearer, more appealing copy.",
    },
    cpc: {
      ar: "تكلفة النقرة (CPC) تعني متوسط المبلغ الذي دفعناه لكل نقرة واحدة.",
      en: "CPC is the average amount we paid for one click.",
    },
    cpa: {
      ar: "تكلفة النتيجة (CPA) تعني متوسط ما دفعناه للحصول على نتيجة واحدة (طلب أو تسجيل).",
      en: "CPA is the average we paid to get one result (a lead or a signup).",
    },
    conversions: {
      ar: "النتائج أو التحويلات هي الإجراءات المفيدة: رسالة، طلب، أو عملية شراء.",
      en: "Conversions are the valuable actions: a message, a request, or a purchase.",
    },
    spend: {
      ar: "الإنفاق هو المبلغ الذي صُرف من ميزانية الحملة، وهو لا يتجاوز الحد الذي اتفقنا عليه.",
      en: "Spend is the amount used from the campaign budget, and it never exceeds the agreed limit.",
    },
  };
  const entry = dictionary[metric.toLowerCase()];
  if (!entry) {
    return locale === "ar"
      ? "هذا المصطلح غير مدرج في القاموس المبسّط. اكتب لنا وسنشرحه لك بجملة واحدة."
      : "That term is not in the simplified glossary yet. Ask us and we will explain it in one sentence.";
  }
  return locale === "ar" ? entry.ar : entry.en;
}

export function glossary(locale: Locale): { key: string; text: string }[] {
  return ["impressions", "clicks", "ctr", "cpc", "cpa", "conversions", "spend"].map((key) => ({
    key,
    text: explainMetric(key, locale),
  }));
}
