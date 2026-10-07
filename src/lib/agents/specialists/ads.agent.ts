import { formatMoney } from "@/lib/core/money";
import type { CampaignPlatform, CampaignRow, CustomerRow, Locale, ProjectRow } from "@/lib/domain/types";
import { listCampaignMetrics, listCampaigns } from "@/lib/repositories/growth.repo";
import {
  budgetState,
  createCampaignForCustomer,
  pauseCampaign,
  parseSafeLimits,
  suggestCampaignChange,
} from "@/lib/services/campaigns.service";

import { runAgent } from "../runtime";

/**
 * Ads manager agent.
 *
 * Plans campaigns and proposes optimisations inside SAFE limits. The platform
 * never spends money by itself: campaign creation always produces a DRAFT that a
 * human activates, and anything outside the agreed envelope is recorded as a
 * suggestion awaiting approval (see campaigns.service.ts for the enforcement).
 */
export interface AdsPlan {
  platform: CampaignPlatform;
  name: string;
  objective: string;
  dailyBudgetMinor: number;
  monthlyBudgetMinor: number;
  totalBudgetMinor: number;
  days: number;
  audience: { name: string; rationale: string }[];
  keywords: { keyword: string; matchType: string; rationale: string }[];
  adCopy: { headline: string; body: string }[];
  notesAr: string[];
  notesEn: string[];
}

export function buildAdsPlan(input: {
  customer: CustomerRow;
  platform: CampaignPlatform;
  objective: string;
  budgetTotalMinor: number;
  days: number;
  platforms: string[];
  locale: Locale;
  brandName?: string | null;
}): AdsPlan {
  const days = Math.max(1, input.days);
  const daily = Math.max(100, Math.round(input.budgetTotalMinor / days));
  const monthly = Math.min(input.budgetTotalMinor, daily * 30);
  const brand = input.brandName ?? input.customer.company_name ?? input.customer.contact_name;
  const isAr = input.locale === "ar";

  return {
    platform: input.platform,
    name: isAr ? `حملة ${input.objective} — ${brand}` : `${input.objective} campaign — ${brand}`,
    objective: input.objective,
    dailyBudgetMinor: daily,
    monthlyBudgetMinor: monthly,
    totalBudgetMinor: input.budgetTotalMinor,
    days,
    audience: [
      {
        name: isAr ? `اهتمامات مرتبطة بالخدمة داخل ${input.customer.country ?? "السوق المستهدف"}` : `In-market interests in ${input.customer.country ?? "the target market"}`,
        rationale: isAr
          ? "جمهور يبحث فعليًا عن خدمة مشابهة، وهذا عادة أرخص من الاستهداف الواسع."
          : "People already looking for a similar service — usually cheaper than broad targeting.",
      },
      {
        name: isAr ? "إعادة استهداف زوار الموقع" : "Remarketing: website visitors",
        rationale: isAr
          ? "من زار الموقع ولم يكمل الطلب يكون أقرب للتحويل."
          : "Visitors who did not convert are usually the closest to converting.",
      },
    ],
    keywords: [
      {
        keyword: isAr ? "خدمة تسويق رقمي" : "digital marketing service",
        matchType: "PHRASE",
        rationale: isAr ? "نية شراء واضحة مع صياغة مرنة." : "Clear buying intent with flexible phrasing.",
      },
      {
        keyword: isAr ? "إدارة حسابات التواصل" : "social media management",
        matchType: "BROAD",
        rationale: isAr ? "كلمة عامة لاكتشاف طلبات جديدة." : "Broad term to discover new demand.",
      },
    ],
    adCopy: [
      {
        headline: isAr ? `${brand} — تسويق بمتابعة يومية` : `${brand} — marketing with daily follow-up`,
        body: isAr
          ? "فريق يدير حملتك ويشرح الأرقام بلغة واضحة، مع تقارير منتظمة."
          : "A team that runs your campaign and explains the numbers plainly, with regular reports.",
      },
    ],
    notesAr: [
      "الحملة تُنشأ كمسودة ولا تُنشط إلا بعد موافقتك وتأكيد الميزانية.",
      "لا يرفع النظام الميزانية تلقائيًا ولا يتجاوز الحد اليومي أو الشهري أبدًا.",
      "هذه قائمة مبدئية مبنية على سياسة الوكالة، لأن حساب المنصة غير مربوط بعد.",
    ],
    notesEn: [
      "The campaign is created as a draft and only activates after your approval and budget confirmation.",
      "The platform never raises the budget by itself and never exceeds the daily or monthly cap.",
      "This starter list follows the agency policy because no ads account is connected yet.",
    ],
  };
}

export interface AdsPlanOutcome {
  campaign: CampaignRow;
  plan: AdsPlan;
  status: "DRAFT" | "AWAITING_APPROVAL";
}

export async function createAdsPlan(input: {
  customer: CustomerRow;
  project: ProjectRow | null;
  platform: CampaignPlatform;
  objective: string;
  budgetTotalMinor: number;
  days: number;
  platforms: string[];
  locale: Locale;
  actorUserId?: string | null;
}): Promise<AdsPlanOutcome> {
  const plan = buildAdsPlan({
    customer: input.customer,
    platform: input.platform,
    objective: input.objective,
    budgetTotalMinor: input.budgetTotalMinor,
    days: input.days,
    platforms: input.platforms,
    locale: input.locale,
  });

  const campaign = await createCampaignForCustomer({
    customer: input.customer,
    name: plan.name,
    platform: input.platform,
    objective: plan.objective,
    totalBudgetMinor: plan.totalBudgetMinor,
    dailyBudgetMinor: plan.dailyBudgetMinor,
    monthlyBudgetMinor: plan.monthlyBudgetMinor,
    startDate: new Date().toISOString(),
    endDate: new Date(Date.now() + input.days * 86_400_000).toISOString(),
    targeting: plan.audience,
    keywords: plan.keywords,
    adCopy: plan.adCopy,
    projectId: input.project?.id ?? null,
    actorUserId: input.actorUserId ?? null,
    actorAgent: "ads_manager",
    autopilot: true,
  });

  const outcome = await runAgent(
    "ads_manager",
    {
      trigger: "plan.requested",
      locale: input.locale,
      customerId: input.customer.id,
      projectId: input.project?.id ?? null,
      input: { platform: input.platform, budgetTotalMinor: input.budgetTotalMinor },
    },
    async ({ record }) => {
      record({
        action: "campaign.planned",
        summary: `خطة حملة ${input.platform} بميزانية ${formatMoney(plan.totalBudgetMinor, input.customer.currency, input.locale)}`,
        reason: "تخطيط داخل الحدود الآمنة، التفعيل يحتاج قرارًا بشريًا",
        entityType: "campaign",
        entityId: campaign.id,
        riskLevel: "MEDIUM",
        requiresApproval: true,
        payload: {
          dailyBudgetMinor: plan.dailyBudgetMinor,
          monthlyBudgetMinor: plan.monthlyBudgetMinor,
        },
      });
      return {
        data: { campaignId: campaign.id },
        summary: "خطة حملة جاهزة للمراجعة",
        riskLevel: "MEDIUM",
      };
    },
  );
  void outcome;

  return { campaign, plan, status: "AWAITING_APPROVAL" };
}

export interface OptimizationRun {
  campaignId: string;
  applied: { changeType: string; reason: string }[];
  suggested: { changeId: string; changeType: string; reason: string }[];
  skipped: string[];
}

/**
 * Reviews a campaign's metrics and applies only what the safe envelope allows.
 * Everything else becomes a recorded suggestion for the owner/partner.
 */
export async function optimizeCampaign(input: {
  campaignId: string;
  locale: Locale;
  actorUserId?: string | null;
}): Promise<OptimizationRun> {
  const { findCampaignById } = await import("@/lib/repositories/growth.repo");
  const campaign = await findCampaignById(input.campaignId);
  if (!campaign) throw new Error("Campaign not found");

  const metrics = await listCampaignMetrics(campaign.id, { limit: 30 });
  const totals = metrics.reduce(
    (accumulator, row) => ({
      impressions: accumulator.impressions + row.impressions,
      clicks: accumulator.clicks + row.clicks,
      cost: accumulator.cost + row.cost_minor,
      conversions: accumulator.conversions + row.conversions,
    }),
    { impressions: 0, clicks: 0, cost: 0, conversions: 0 },
  );
  const ctr = totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : 0;
  const limits = parseSafeLimits(campaign.safe_limits);
  const state = budgetState(campaign);

  const applied: OptimizationRun["applied"] = [];
  const suggested: OptimizationRun["suggested"] = [];
  const skipped: string[] = [];

  // 1) Pause a weak ad — allowed automatically inside the agreed limits.
  if (
    totals.impressions >= limits.minImpressionsBeforePause &&
    ctr < limits.weakCtrThreshold &&
    limits.allowAutoPause &&
    campaign.status === "ACTIVE"
  ) {
    await pauseCampaign(campaign.id, {
      agentKey: "ads_manager",
      reason: `CTR ${ctr.toFixed(2)}% below the agreed threshold ${limits.weakCtrThreshold}%`,
    });
    applied.push({
      changeType: "PAUSE_WEAK_AD",
      reason: input.locale === "ar"
        ? `أوقفنا الإعلان لأن نسبة النقر ${ctr.toFixed(2)}% أقل من الحد المتفق عليه، وهذا يحمي الميزانية.`
        : `Paused the ad: CTR ${ctr.toFixed(2)}% is below the agreed threshold, protecting the budget.`,
    });
  } else if (metrics.length === 0) {
    skipped.push("no_metrics");
  } else if (ctr >= limits.weakCtrThreshold) {
    skipped.push("ctr_acceptable");
  }

  // 2) Copy improvements — recorded as suggestions, applied by a human.
  if (totals.cost > 0 && totals.clicks === 0) {
    const changeId = await suggestCampaignChange(campaign.id, {
      changeType: "IMPROVE_AD_COPY",
      reason: input.locale === "ar"
        ? "تم صرف ميزانية بلا نقرات: نقترح نصًا أوضح يبدأ بالفائدة الأساسية ثم طلب واحد."
        : "Budget was spent with no clicks: we suggest clearer copy that leads with one benefit.",
      payload: { cost: totals.cost, impressions: totals.impressions },
      riskLevel: "MEDIUM",
      agentKey: "ads_manager",
    });
    suggested.push({
      changeId,
      changeType: "IMPROVE_AD_COPY",
      reason: input.locale === "ar" ? "اقتراح تحسين نص الإعلان" : "Ad copy improvement suggestion",
    });
  }

  // 3) Budget matters are ALWAYS a suggestion, never automatic.
  if (state.burnRatePercent > 85 && state.daysRemaining !== null && state.daysRemaining > 3) {
    const changeId = await suggestCampaignChange(campaign.id, {
      changeType: "REVIEW_PACING",
      reason: input.locale === "ar"
        ? "الإنفاق أسرع من المدة المتبقية. أي زيادة في الميزانية تحتاج موافقتك."
        : "Spend is faster than the remaining period. Any budget increase needs your approval.",
      payload: { spend: state.spentMinor, remaining: state.remainingMinor },
      riskLevel: "HIGH",
      agentKey: "ads_manager",
    });
    suggested.push({
      changeId,
      changeType: "REVIEW_PACING",
      reason: input.locale === "ar" ? "مراجعة سرعة الإنفاق" : "Review spend pacing",
    });
  }

  const outcome = await runAgent(
    "ads_manager",
    {
      trigger: "daily_job",
      locale: input.locale,
      customerId: campaign.customer_id,
      input: { campaignId: campaign.id, applied: applied.length, suggested: suggested.length },
    },
    async ({ record }) => {
      for (const entry of applied) {
        record({
          action: entry.changeType,
          summary: entry.reason,
          entityType: "campaign",
          entityId: campaign.id,
          riskLevel: "LOW",
          requiresApproval: false,
          payload: { autoApplied: true },
        });
      }
      for (const entry of suggested) {
        record({
          action: entry.changeType,
          summary: entry.reason,
          entityType: "campaign",
          entityId: campaign.id,
          riskLevel: "MEDIUM",
          requiresApproval: true,
        });
      }
      return {
        data: { applied: applied.length, suggested: suggested.length, skipped },
        summary: `تحسين الحملة: ${applied.length} تغيير آلي و${suggested.length} اقتراح للمراجعة`,
        riskLevel: applied.length > 0 ? "MEDIUM" : "LOW",
      };
    },
  );
  void outcome;

  return { campaignId: campaign.id, applied, suggested, skipped };
}

/** Explanation for the client about what the agent may and may not do. */
export function describeAdsBoundaries(locale: Locale): string {
  return locale === "ar"
    ? "يستطيع الوكيل تحسين النصوص، إيقاف إعلان ضعيف، وتحسين الكلمات والاستهداف داخل الميزانية المتفق عليها. ولا يستطيع أبدًا رفع الميزانية الإجمالية أو تجاوز الحد اليومي أو الشهري أو تغيير وسيلة الدفع أو إنشاء حملة جديدة تنفق أموالًا."
    : "The agent may improve copy, pause a weak ad, and refine keywords/targeting inside the agreed budget. It can never raise the total budget, exceed the daily or monthly cap, change the payment method, or create a new campaign that spends money.";
}

export async function campaignsForCustomer(customerId: string): Promise<CampaignRow[]> {
  const { rows } = await listCampaigns({ customerId, limit: 50 });
  return rows;
}
