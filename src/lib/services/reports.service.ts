import { formatDate, toDateKey } from "@/lib/core/date";
import { formatMoney } from "@/lib/core/money";
import { logger } from "@/lib/core/logger";
import type { CampaignRow, CustomerRow, Locale, ReportRow } from "@/lib/domain/types";
import {
  aggregateMetrics,
  createReport,
  findReportForDay,
  listCampaignMetrics,
  listRecentCampaignChanges,
  listReports,
  updateReport,
} from "@/lib/repositories/growth.repo";
import { findCampaignById, listActiveCampaigns } from "@/lib/repositories/growth.repo";
import { findCustomerById } from "@/lib/repositories/customers.repo";
import { findProjectById, listProjectTasks } from "@/lib/repositories/projects.repo";
import { createNotification } from "@/lib/repositories/messaging.repo";
import { finishJobRun, findJobRunByKeyToday, startJobRun } from "@/lib/repositories/governance.repo";

import { logActivity } from "./activity.service";
import { sendEmail } from "./email.service";
import { getAgencySettings } from "./settings.service";
import { budgetState } from "./campaigns.service";

/**
 * Reporting.
 *
 * Client-facing reports are written in plain language and explain every term.
 * They answer, in order:
 *   what happened today · how much was spent · impressions · clicks ·
 *   results/conversions (when available) · is performance good or does it need
 *   work · what the agent changed · what happens next · any important warning.
 *
 * Every report ends with an invitation to ask for a deeper explanation, and the
 * deep report expands the numbers and the glossary.
 *
 * Internal costs and margins are NEVER included in a client report.
 */

export interface DailyReportContent {
  title: string;
  summary: string;
  bodyAr: string;
  bodyEn: string;
  metrics: Record<string, number | string>;
  warnings: string[];
}

export const METRIC_GLOSSARY: { key: string; ar: string; en: string }[] = [
  { key: "impressions", ar: "مرات الظهور: عدد المرات التي ظهر فيها إعلانك للجمهور.", en: "Impressions: how many times your ad was shown." },
  { key: "clicks", ar: "النقرات: عدد المرات التي ضغط فيها الناس على إعلانك.", en: "Clicks: how many times people clicked your ad." },
  { key: "ctr", ar: "نسبة النقر (CTR): من كل ١٠٠ مشاهدة، كم شخصًا ضغط. الأعلى أفضل.", en: "CTR: out of every 100 views, how many clicked. Higher is better." },
  { key: "cpc", ar: "تكلفة النقرة (CPC): متوسط ما دفعناه لكل نقرة.", en: "CPC: the average we paid for each click." },
  { key: "cpa", ar: "تكلفة النتيجة (CPA): متوسط التكلفة للحصول على نتيجة (طلب/تسجيل).", en: "CPA: the average cost of one result (lead/signup)." },
  { key: "conversions", ar: "النتائج/التحويلات: عدد الإجراءات المفيدة التي قام بها الناس.", en: "Conversions: the number of valuable actions people took." },
  { key: "spend", ar: "الإنفاق: المبلغ الذي صُرف من ميزانية الحملة.", en: "Spend: the amount used from the campaign budget." },
  { key: "budget", ar: "الميزانية: المبلغ الذي خصصته للحملة.", en: "Budget: the amount you allocated to the campaign." },
];

export async function buildDailyReportContent(
  campaign: CampaignRow,
  locale: Locale,
  dayKey: string,
): Promise<DailyReportContent> {
  const metricsRows = await listCampaignMetrics(campaign.id, { fromDate: dayKey, toDate: dayKey });
  const totals = await aggregateMetrics({ campaignId: campaign.id, fromDate: dayKey, toDate: dayKey });
  const changes = (await listRecentCampaignChanges(`${dayKey}T00:00:00.000Z`, 20)).filter(
    (change) => change.campaign_id === campaign.id,
  );
  const budget = budgetState(campaign);

  const ctr = totals.impressions > 0 ? Number(((totals.clicks / totals.impressions) * 100).toFixed(2)) : 0;
  const cpc = totals.clicks > 0 ? Math.round(totals.cost_minor / totals.clicks) : 0;
  const cpa = totals.conversions > 0 ? Math.round(totals.cost_minor / totals.conversions) : null;

  const warnings: string[] = [];
  if (budget.pacingWarning) warnings.push(budget.pacingWarning);
  if (budget.remainingMinor <= 0) warnings.push("ميزانية الحملة انتهت.");
  if (totals.impressions > 500 && ctr < 0.5) warnings.push("نسبة النقر منخفضة، وقد نقترح تحسين نص الإعلان.");
  if (totals.cost_minor === 0 && metricsRows.length === 0) {
    warnings.push("لا توجد أرقام مسجلة لهذا اليوم بعد. الأرقام تُحدّث عند ربط منصة الإعلانات أو بإدخال يدوي.");
  }

  const isAr = locale === "ar";
  const hasData = metricsRows.length > 0;
  const performanceGood = hasData && ctr >= 0.8 && (!cpa || cpa <= budget.totalMinor / 10);

  const whatHappened = hasData
    ? isAr
      ? `اليوم عملت حملة «${campaign.name}» وحصلت على ${totals.impressions} ظهور و${totals.clicks} نقرة.`
      : `Today the campaign "${campaign.name}" received ${totals.impressions} impressions and ${totals.clicks} clicks.`
    : isAr
      ? `لا توجد أرقام جديدة اليوم لحملة «${campaign.name}».`
      : `No new numbers were recorded today for "${campaign.name}".`;

  const spendLine = isAr
    ? `تم إنفاق ${formatMoney(totals.cost_minor, campaign.currency, "ar")} من أصل ${formatMoney(campaign.total_budget_minor, campaign.currency, "ar")}، والمتبقي ${formatMoney(budget.remainingMinor, campaign.currency, "ar")}.`
    : `Spent ${formatMoney(totals.cost_minor, campaign.currency, "en")} of ${formatMoney(campaign.total_budget_minor, campaign.currency, "en")}; ${formatMoney(budget.remainingMinor, campaign.currency, "en")} remains.`;

  const resultsLine = isAr
    ? totals.conversions > 0
      ? `النتائج اليوم: ${totals.conversions} تحويل${cpa ? ` بمتوسط تكلفة ${formatMoney(cpa, campaign.currency, "ar")} لكل نتيجة` : ""}.`
      : "لم تُسجّل تحويلات اليوم. قد يكون ذلك طبيعيًا في بداية الحملة، ونراقبها عن قرب."
    : totals.conversions > 0
      ? `Results today: ${totals.conversions} conversions${cpa ? ` at an average cost of ${formatMoney(cpa, campaign.currency, "en")} each` : ""}.`
      : "No conversions were recorded today. That can be normal at the start, and we are watching closely.";

  const performanceLine = isAr
    ? performanceGood
      ? "الأداء جيد اليوم بالمقارنة مع المعتاد."
      : hasData
        ? "الأداء يحتاج تحسينًا، وسنعمل على النصوص والاستهداف."
        : "لا يمكن تقييم الأداء قبل وصول الأرقام."
    : performanceGood
      ? "Performance looks good today compared with the usual range."
      : hasData
        ? "Performance needs improvement; we will work on the copy and targeting."
        : "Performance cannot be assessed until numbers arrive.";

  const changesLine = changes.length
    ? isAr
      ? `الذي عُدِّل اليوم: ${changes.length} تغييرًا. ${changes
          .slice(0, 3)
          .map((change) => `${change.change_type}${change.reason ? ` (${change.reason})` : ""}`)
          .join(" • ")}`
      : `Changes today: ${changes.length}. ${changes
          .slice(0, 3)
          .map((change) => `${change.change_type}${change.reason ? ` (${change.reason})` : ""}`)
          .join(" • ")}`
    : isAr
      ? "لم نحتج إلى أي تعديل اليوم، والحملة تعمل كما هي."
      : "No changes were needed today; the campaign is running as is.";

  const nextLine = isAr
    ? "الخطوة التالية: متابعة الأرقام يوميًا، واقتراح تحسينات على النصوص والاستهداف داخل نفس الميزانية المتفق عليها."
    : "Next: we keep monitoring daily and suggest improvements to copy and targeting within the same agreed budget.";

  const closing = isAr ? await deepReportInvitation("ar") : await deepReportInvitation("en");

  const summary = isAr
    ? `${whatHappened} ${spendLine} ${performanceLine}`
    : `${whatHappened} ${spendLine} ${performanceLine}`;

  const bodyAr = [
    `تقرير حملة «${campaign.name}» — ${formatDate(dayKey, "ar", "long")}`,
    "",
    `١) ماذا حدث اليوم؟`,
    whatHappened,
    "",
    `٢) الإنفاق`,
    spendLine,
    `الحد اليومي المتفق عليه: ${formatMoney(campaign.daily_budget_minor, campaign.currency, "ar")} • الحد الشهري: ${formatMoney(campaign.monthly_budget_minor, campaign.currency, "ar")}`,
    "",
    `٣) الأرقام`,
    `• مرات الظهور: ${totals.impressions}`,
    `• النقرات: ${totals.clicks}`,
    `• نسبة النقر (CTR): ${ctr}%`,
    `• متوسط تكلفة النقرة: ${formatMoney(cpc, campaign.currency, "ar")}`,
    `• ${resultsLine}`,
    "",
    `٤) هل الأداء جيد؟`,
    performanceLine,
    "",
    `٥) ما الذي عدّله الوكيل؟`,
    changesLine,
    "",
    `٦) ماذا سيفعل النظام بعد ذلك؟`,
    nextLine,
    warnings.length ? `\n⚠ تنبيه مهم:\n${warnings.map((warning) => `• ${warning}`).join("\n")}` : "",
    "",
    closing,
  ]
    .filter((line) => line !== undefined)
    .join("\n");

  const bodyEn = [
    `Campaign report — ${campaign.name} (${formatDate(dayKey, "en", "long")})`,
    "",
    "1) What happened today?",
    whatHappened,
    "",
    "2) Spend",
    spendLine,
    "",
    "3) Numbers",
    `• Impressions: ${totals.impressions}`,
    `• Clicks: ${totals.clicks}`,
    `• CTR: ${ctr}%`,
    `• Average CPC: ${formatMoney(cpc, campaign.currency, "en")}`,
    `• ${resultsLine}`,
    "",
    "4) Is performance good?",
    performanceLine,
    "",
    "5) What did the agent change?",
    changesLine,
    "",
    "6) What happens next?",
    nextLine,
    warnings.length ? `\n⚠ Important warnings:\n${warnings.map((warning) => `• ${warning}`).join("\n")}` : "",
    "",
    closing,
  ].join("\n");

  return {
    title: isAr
      ? `تقرير يومي — ${campaign.name} (${formatDate(dayKey, "ar")})`
      : `Daily report — ${campaign.name} (${formatDate(dayKey, "en")})`,
    summary,
    bodyAr,
    bodyEn,
    metrics: {
      impressions: totals.impressions,
      clicks: totals.clicks,
      cost_minor: totals.cost_minor,
      conversions: totals.conversions,
      ctr,
      cpc_minor: cpc,
      spend_total_minor: campaign.spent_minor,
      budget_total_minor: campaign.total_budget_minor,
    },
    warnings,
  };
}

async function deepReportInvitation(locale: Locale): Promise<string> {
  const settings = await getAgencySettings();
  if (!settings.deepReportOnRequest) {
    return locale === "ar"
      ? "إذا احتجت أي توضيح، راسلنا عبر بوابة العميل."
      : "If you need any clarification, message us from the client portal.";
  }
  return locale === "ar"
    ? "هل تريد تفاصيل أكثر؟ اكتب «تفاصيل أكثر» في بوابة العميل وسنرسل تقريرًا مفصّلًا يشرح كل رقم ومصطلح بطريقة مبسطة."
    : 'Want more detail? Write "more details" in the client portal and we will send a deeper report explaining every number and term.';
}

/** Generates and delivers one campaign's daily report (idempotent per day). */
export async function sendDailyCampaignReport(
  campaign: CampaignRow,
  dayKey = toDateKey(new Date()),
): Promise<{ report: ReportRow; delivered: boolean } | null> {
  const existing = await findReportForDay(campaign.id, dayKey);
  if (existing) return null;

  const customer = await findCustomerById(campaign.customer_id);
  if (!customer) return null;

  const locale: Locale = customer.locale;
  const content = await buildDailyReportContent(campaign, locale, dayKey);

  const report = await createReport({
    customer_id: campaign.customer_id,
    campaign_id: campaign.id,
    project_id: campaign.project_id,
    report_type: "CAMPAIGN_DAILY",
    language: locale,
    period_start: dayKey,
    period_end: dayKey,
    title: content.title,
    summary: content.summary,
    body: locale === "ar" ? content.bodyAr : content.bodyEn,
    metrics: JSON.stringify(content.metrics),
    status: "DRAFT",
    generated_by_agent: "reporting",
  });

  let delivered = false;
  if (customer.email) {
    const result = await sendEmail({
      to: customer.email,
      userId: customer.user_id,
      template: "daily_report",
      subject: content.title,
      text: locale === "ar" ? content.bodyAr : content.bodyEn,
      meta: { reportId: report.id, campaignId: campaign.id },
    });
    delivered = result.delivered;
  }

  if (customer.user_id) {
    await createNotification({
      user_id: customer.user_id,
      channel: "IN_APP",
      subject: content.title,
      body: content.summary,
      status: "QUEUED",
    });
  }

  await updateReport(report.id, { status: delivered ? "SENT" : "DRAFT", sent_at: delivered ? new Date().toISOString() : null });

  await logActivity({
    actor_type: "AGENT",
    actor_label: "reporting",
    action: "report.daily_sent",
    entity_type: "report",
    entity_id: report.id,
    customer_id: campaign.customer_id,
    summary: `Daily report for "${campaign.name}" (${dayKey})`,
  });

  return { report, delivered };
}

/** Deeper report requested by the client, with a plain-language glossary. */
export async function sendDeepCampaignReport(
  campaignId: string,
  actorUserId: string,
  periodDays = 30,
): Promise<ReportRow> {
  const campaign = await findCampaignById(campaignId);
  if (!campaign) throw new Error("Campaign not found");
  const customer = await findCustomerById(campaign.customer_id);
  const locale: Locale = customer?.locale ?? "ar";
  const from = toDateKey(new Date(Date.now() - periodDays * 86_400_000));
  const to = toDateKey(new Date());

  const totals = await aggregateMetrics({ campaignId, fromDate: from, toDate: to });
  const series = await listCampaignMetrics(campaignId, { fromDate: from, toDate: to, limit: periodDays });
  const budget = budgetState(campaign);
  const ctr = totals.impressions > 0 ? Number(((totals.clicks / totals.impressions) * 100).toFixed(2)) : 0;
  const cpc = totals.clicks > 0 ? Math.round(totals.cost_minor / totals.clicks) : 0;
  const cpa = totals.conversions > 0 ? Math.round(totals.cost_minor / totals.conversions) : null;

  const isAr = locale === "ar";
  const glossary = METRIC_GLOSSARY.map((term) => `• ${isAr ? term.ar : term.en}`).join("\n");

  const body = isAr
    ? [
        `تقرير مفصّل — حملة «${campaign.name}»`,
        `الفترة: من ${formatDate(from, "ar", "long")} إلى ${formatDate(to, "ar", "long")}`,
        "",
        "الأرقام الإجمالية:",
        `• مرات الظهور: ${totals.impressions}`,
        `• النقرات: ${totals.clicks}`,
        `• نسبة النقر: ${ctr}%`,
        `• الإنفاق: ${formatMoney(totals.cost_minor, campaign.currency, "ar")}`,
        `• متوسط تكلفة النقرة: ${formatMoney(cpc, campaign.currency, "ar")}`,
        cpa ? `• متوسط تكلفة النتيجة: ${formatMoney(cpa, campaign.currency, "ar")}` : "• لا توجد نتائج مسجلة بعد لاحتساب تكلفة النتيجة.",
        "",
        "الميزانية:",
        `• الإجمالي المتفق عليه: ${formatMoney(campaign.total_budget_minor, campaign.currency, "ar")}`,
        `• المصروف: ${formatMoney(budget.spentMinor, campaign.currency, "ar")} (${budget.burnRatePercent}%)`,
        `• المتبقي: ${formatMoney(budget.remainingMinor, campaign.currency, "ar")}`,
        `• الحد اليومي: ${formatMoney(campaign.daily_budget_minor, campaign.currency, "ar")} • الحد الشهري: ${formatMoney(campaign.monthly_budget_minor, campaign.currency, "ar")}`,
        "",
        "التطور اليومي (آخر أيام مسجلة):",
        ...series.slice(-10).map(
          (row) =>
            `• ${row.metric_date}: ${row.impressions} ظهور · ${row.clicks} نقرة · ${formatMoney(row.cost_minor, campaign.currency, "ar")}`,
        ),
        "",
        "شرح المصطلحات ببساطة:",
        glossary,
        "",
        "ملاحظة: هذه الأرقام تعتمد على ما هو مسجل في النظام. عند ربط منصة الإعلانات ستُحدَّث تلقائيًا.",
      ].join("\n")
    : [
        `Deep report — ${campaign.name}`,
        `Period: ${formatDate(from, "en", "long")} → ${formatDate(to, "en", "long")}`,
        "",
        "Totals:",
        `• Impressions: ${totals.impressions}`,
        `• Clicks: ${totals.clicks}`,
        `• CTR: ${ctr}%`,
        `• Spend: ${formatMoney(totals.cost_minor, campaign.currency, "en")}`,
        `• Average CPC: ${formatMoney(cpc, campaign.currency, "en")}`,
        cpa ? `• Average CPA: ${formatMoney(cpa, campaign.currency, "en")}` : "• Not enough results yet to compute CPA.",
        "",
        "Budget:",
        `• Agreed total: ${formatMoney(campaign.total_budget_minor, campaign.currency, "en")}`,
        `• Spent: ${formatMoney(budget.spentMinor, campaign.currency, "en")} (${budget.burnRatePercent}%)`,
        `• Remaining: ${formatMoney(budget.remainingMinor, campaign.currency, "en")}`,
        "",
        "Daily trend (last recorded days):",
        ...series.slice(-10).map(
          (row) =>
            `• ${row.metric_date}: ${row.impressions} impressions · ${row.clicks} clicks · ${formatMoney(row.cost_minor, campaign.currency, "en")}`,
        ),
        "",
        "Plain-language glossary:",
        glossary,
      ].join("\n");

  const report = await createReport({
    customer_id: campaign.customer_id,
    campaign_id: campaign.id,
    project_id: campaign.project_id,
    report_type: "CAMPAIGN_DEEP",
    language: locale,
    period_start: from,
    period_end: to,
    title: isAr ? `تقرير مفصّل — ${campaign.name}` : `Deep report — ${campaign.name}`,
    summary: isAr
      ? `تفاصيل ${periodDays} يوم لحملة ${campaign.name}`
      : `${periodDays}-day detail for ${campaign.name}`,
    body,
    metrics: JSON.stringify(totals),
    status: "SENT",
    generated_by_agent: "reporting",
    sent_at: new Date().toISOString(),
  });

  if (customer?.email) {
    await sendEmail({
      to: customer.email,
      userId: customer.user_id,
      template: "deep_report",
      subject: report.title,
      text: body,
      meta: { reportId: report.id },
    });
  }

  await logActivity({
    actor_type: "USER",
    actor_user_id: actorUserId,
    action: "report.deep_sent",
    entity_type: "report",
    entity_id: report.id,
    customer_id: campaign.customer_id,
    summary: `Deep report sent for "${campaign.name}"`,
  });

  return report;
}

/** Project completion report shown in the client portal. */
export async function buildProjectReport(projectId: string, locale: Locale): Promise<ReportRow> {
  const project = await findProjectById(projectId);
  if (!project) throw new Error("Project not found");
  const tasks = await listProjectTasks(projectId, { includeInternal: false });
  const done = tasks.filter((task) => task.status === "DONE").length;
  const isAr = locale === "ar";

  const body = isAr
    ? [
        `ملخص مشروع ${project.code} — ${project.title}`,
        "",
        `عدد المهام المنجزة: ${done} من ${tasks.length}`,
        `نسبة الإنجاز: ${project.progress}%`,
        project.due_date ? `تاريخ التسليم: ${formatDate(project.due_date, "ar", "long")}` : "",
        "",
        "المهام:",
        ...tasks.map((task) => `• ${task.title} — ${task.status === "DONE" ? "منجزة" : "قيد العمل"}`),
      ]
        .filter(Boolean)
        .join("\n")
    : [
        `Project summary ${project.code} — ${project.title}`,
        "",
        `Completed tasks: ${done} of ${tasks.length}`,
        `Progress: ${project.progress}%`,
        "",
        "Tasks:",
        ...tasks.map((task) => `• ${task.title} — ${task.status === "DONE" ? "done" : "in progress"}`),
      ].join("\n");

  return createReport({
    customer_id: project.customer_id,
    project_id: projectId,
    report_type: "PROJECT",
    language: locale,
    title: isAr ? `تقرير المشروع ${project.code}` : `Project report ${project.code}`,
    summary: isAr ? `إنجاز ${project.progress}%` : `${project.progress}% complete`,
    body,
    status: "DRAFT",
    generated_by_agent: "project_manager",
  });
}

/* ----------------------------------------------------------------- daily job - */

/**
 * Daily reporting job (run from /api/cron/daily or the CLI).
 * Idempotent: a second run on the same day does nothing.
 */
export async function runDailyJob(): Promise<{
  campaignsProcessed: number;
  reportsSent: number;
  lateProjects: number;
  overdueInvoices: number;
  renewalsProcessed: number;
  summaries: string[];
}> {
  const dayKey = toDateKey(new Date());
  const settings = await getAgencySettings();

  const previous = await findJobRunByKeyToday("daily_reports", dayKey);
  if (previous) {
    return {
      campaignsProcessed: 0,
      reportsSent: 0,
      lateProjects: 0,
      overdueInvoices: 0,
      renewalsProcessed: 0,
      summaries: ["Already completed today."],
    };
  }

  const jobId = await startJobRun("daily_reports", { dayKey });
  const summaries: string[] = [];
  let processed = 0;
  let sent = 0;

  try {
    if (settings.dailyReportEnabled) {
      const campaigns = await listActiveCampaigns();
      for (const campaign of campaigns) {
        processed += 1;
        try {
          const result = await sendDailyCampaignReport(campaign, dayKey);
          if (result) {
            sent += 1;
            summaries.push(`report:${campaign.id}`);
          }
        } catch (error) {
          logger.error("Daily report failed for campaign", { campaignId: campaign.id, error });
          summaries.push(`failed:${campaign.id}`);
        }
      }
    }

    const [{ detectLateProjects }, { markOverdueInvoices }, { processDueRenewals }, { expireOldOffers }] =
      await Promise.all([
        import("./projects.service"),
        import("./billing.service"),
        import("./billing.service"),
        import("./offers.service"),
      ]);

    const lateProjects = await detectLateProjects();
    const overdueInvoices = await markOverdueInvoices();
    const renewals = await processDueRenewals();
    const expiredOffers = await expireOldOffers();

    if (lateProjects > 0) summaries.push(`late projects: ${lateProjects}`);
    if (overdueInvoices > 0) summaries.push(`overdue invoices: ${overdueInvoices}`);
    if (renewals.paused > 0) summaries.push(`renewal invoices issued: ${renewals.paused}`);
    if (expiredOffers > 0) summaries.push(`expired offers: ${expiredOffers}`);

    const { processOutbox } = await import("./email.service");
    const outbox = await processOutbox(50);
    if (outbox.sent > 0) summaries.push(`emails retried: ${outbox.sent}`);

    await finishJobRun(jobId, {
      status: "SUCCEEDED",
      itemsProcessed: processed,
      summary: summaries.join(", "),
    });

    return {
      campaignsProcessed: processed,
      reportsSent: sent,
      lateProjects,
      overdueInvoices,
      renewalsProcessed: renewals.paused + renewals.renewed,
      summaries,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishJobRun(jobId, { status: "FAILED", itemsProcessed: processed, error: message });
    const { raiseAlert } = await import("./alerts.service");
    await raiseAlert({
      severity: "IMPORTANT",
      category: "jobs",
      title_ar: "فشل تشغيل المهمة اليومية",
      title_en: "Daily job failed",
      body_ar: `لم تكتمل المهمة اليومية: ${message}`,
      body_en: `The daily job did not complete: ${message}`,
      dedupe_key: `job-failed:daily_reports:${dayKey}`,
    });
    throw error;
  }
}

export async function customerReports(customerId: string, limit = 20): Promise<ReportRow[]> {
  const { rows } = await listReports({ customerId, limit });
  return rows;
}

export async function projectReportForClient(projectId: string, customerId: string): Promise<ReportRow | null> {
  const project = await findProjectById(projectId);
  if (!project || project.customer_id !== customerId) return null;
  const { rows } = await listReports({ customerId, limit: 50 });
  return rows.find((row) => row.project_id === projectId && row.report_type === "PROJECT") ?? null;
}

export async function customerById(customerId: string): Promise<CustomerRow | undefined> {
  return findCustomerById(customerId);
}
