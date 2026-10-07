import { googleAdsStatus, planCampaign, proposeOptimizations } from "@/lib/integrations/google-ads";
import type { CampaignRow, CustomerRow, Locale, ServiceRow } from "@/lib/domain/types";
import { listCampaignMetrics } from "@/lib/repositories/growth.repo";
import { parseSafeLimits, suggestCampaignChange } from "@/lib/services/campaigns.service";
import { raiseAlert } from "@/lib/services/alerts.service";

import { runAgent } from "../runtime";

/**
 * Google Ads agent.
 *
 * Wraps the (currently disconnected) Google Ads integration. While the account is
 * not linked it still does useful, honest work: it produces a *proposal* marked as
 * local policy — never as real account data — and records it for the owner.
 *
 * Every financial action is a suggestion that a human approves. The agent cannot
 * raise budgets, exceed caps, change payment methods or create spending
 * campaigns; those rules live in campaigns.service.ts and are enforced there.
 */
export interface GoogleAdsAgentOutcome {
  connected: boolean;
  statusAr: string;
  statusEn: string;
  proposals: { changeId: string | null; changeType: string; reasonAr: string; reasonEn: string }[];
  plan?: {
    suggestedKeywords: { keyword: string; matchType: string; rationale: string }[];
    suggestedAudiences: { name: string; rationale: string }[];
    suggestedDailyBudgetMinor: number;
    notesAr: string[];
    notesEn: string[];
  };
}

export async function reviewGoogleAdsAccount(input: {
  locale: Locale;
  customerId?: string | null;
}): Promise<GoogleAdsAgentOutcome> {
  const status = googleAdsStatus();

  const outcome = await runAgent(
    "google_ads",
    {
      trigger: "manual_review",
      locale: input.locale,
      customerId: input.customerId ?? null,
      input: { connected: status.connected },
    },
    async ({ record }) => {
      record({
        action: status.connected ? "account_review" : "connection_missing",
        summary: status.connected
          ? "مراجعة حساب Google Ads"
          : "تعذّر الاتصال بحساب Google Ads: التكامل غير مربوط",
        reason: status.connected ? undefined : status.reasonEn,
        riskLevel: status.connected ? "MEDIUM" : "LOW",
        requiresApproval: false,
        payload: { missingConfig: status.missingConfig },
      });
      return {
        data: { connected: status.connected, missing: status.missingConfig },
        summary: status.connected
          ? "تمت مراجعة الحساب"
          : "Google Ads غير مربوط — تم تسجيل الحالة والتزم النظام بعدم عرض أي أرقام غير حقيقية",
        riskLevel: "LOW",
      };
    },
  );
  void outcome;

  if (!status.connected) {
    await raiseAlert({
      severity: "INFO",
      category: "integration",
      title_ar: "تكامل Google Ads غير مربوط",
      title_en: "Google Ads integration is not connected",
      body_ar: `${status.reasonAr}\nالمطلوب: ${status.missingConfig.slice(0, 3).join(", ")}${status.missingConfig.length > 3 ? " …" : ""}`,
      body_en: `${status.reasonEn}\nMissing: ${status.missingConfig.slice(0, 3).join(", ")}${status.missingConfig.length > 3 ? " …" : ""}`,
      dedupe_key: "google-ads:not-connected",
      notify: false,
    });
  }

  return {
    connected: status.connected,
    statusAr: status.reasonAr,
    statusEn: status.reasonEn,
    proposals: [],
  };
}

/** Builds a campaign plan proposal (local policy, clearly labelled). */
export async function proposeGoogleAdsCampaign(input: {
  customer: CustomerRow;
  services: ServiceRow[];
  objective: string;
  budgetTotalMinor: number;
  days: number;
  locale: Locale;
}): Promise<GoogleAdsAgentOutcome> {
  const plan = planCampaign({
    objective: input.objective,
    country: input.customer.country,
    language: input.locale,
    currency: input.customer.currency,
    totalBudgetMinor: input.budgetTotalMinor,
    days: input.days,
    brand: input.customer.company_name ?? input.customer.contact_name,
    services: input.services.map((service) =>
      input.locale === "ar" ? service.name_ar : service.name_en,
    ),
  });

  const status = googleAdsStatus();

  const outcome = await runAgent(
    "google_ads",
    {
      trigger: "plan.requested",
      locale: input.locale,
      customerId: input.customer.id,
      input: { budgetTotalMinor: input.budgetTotalMinor, days: input.days },
    },
    async ({ record }) => {
      record({
        action: "campaign_plan.proposed",
        summary: `اقتراح حملة Google Ads بميزانية يومية مقترحة ${plan.suggestedDailyBudgetMinor}`,
        reason: "اقتراح داخلي لا يعتمد على بيانات حساب حقيقي لأن الحساب غير مربوط",
        riskLevel: "MEDIUM",
        requiresApproval: true,
        entityType: "customer",
        entityId: input.customer.id,
      });
      return {
        data: { keywords: plan.suggestedKeywords.length },
        summary: "اقتراح حملة جاهز للمراجعة",
        riskLevel: "MEDIUM",
      };
    },
  );
  void outcome;

  return {
    connected: status.connected,
    statusAr: status.reasonAr,
    statusEn: status.reasonEn,
    proposals: [],
    plan: {
      suggestedKeywords: plan.suggestedKeywords,
      suggestedAudiences: plan.suggestedAudiences,
      suggestedDailyBudgetMinor: plan.suggestedDailyBudgetMinor,
      notesAr: plan.notesAr,
      notesEn: plan.notesEn,
    },
  };
}

/** Reviews a live campaign and records optimisations for approval. */
export async function reviewCampaignPerformance(input: {
  campaign: CampaignRow;
  locale: Locale;
}): Promise<GoogleAdsAgentOutcome> {
  const metrics = await listCampaignMetrics(input.campaign.id, { limit: 30 });
  const limits = parseSafeLimits(input.campaign.safe_limits);
  const proposals = proposeOptimizations({
    campaign: input.campaign,
    metrics,
    limits: {
      weakCtrThreshold: limits.weakCtrThreshold,
      minImpressionsBeforePause: limits.minImpressionsBeforePause,
      allowAutoPause: limits.allowAutoPause,
      allowAutoCopyChanges: limits.allowAutoCopyChanges,
    },
  });

  const recorded: GoogleAdsAgentOutcome["proposals"] = [];
  for (const proposal of proposals) {
    const changeId = await suggestCampaignChange(input.campaign.id, {
      changeType: proposal.changeType,
      reason: proposal.reasonEn,
      payload: proposal.payload,
      riskLevel: proposal.riskLevel,
      agentKey: "google_ads",
    });
    recorded.push({
      changeId,
      changeType: proposal.changeType,
      reasonAr: proposal.reasonAr,
      reasonEn: proposal.reasonEn,
    });
  }

  const status = googleAdsStatus();
  const outcome = await runAgent(
    "google_ads",
    {
      trigger: "manual_review",
      locale: input.locale,
      customerId: input.campaign.customer_id,
      input: { campaignId: input.campaign.id, proposals: recorded.length },
    },
    async ({ record }) => {
      for (const proposal of recorded) {
        record({
          action: proposal.changeType,
          summary: proposal.reasonEn,
          entityType: "campaign",
          entityId: input.campaign.id,
          riskLevel: "MEDIUM",
          requiresApproval: true,
        });
      }
      return {
        data: { proposals: recorded.length, connected: status.connected },
        summary: `${recorded.length} اقتراح تحسين مسجل للمراجعة`,
        riskLevel: recorded.length > 0 ? "MEDIUM" : "LOW",
      };
    },
  );
  void outcome;

  return {
    connected: status.connected,
    statusAr: status.reasonAr,
    statusEn: status.reasonEn,
    proposals: recorded,
  };
}
