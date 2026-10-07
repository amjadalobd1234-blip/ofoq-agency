import { getEnv } from "@/lib/config/env";
import { IntegrationDisabledError } from "@/lib/core/errors";
import { logger } from "@/lib/core/logger";
import type { CampaignRow, Locale } from "@/lib/domain/types";
import type { CampaignMetricsRow } from "@/lib/domain/types";
import { upsertCampaignMetrics } from "@/lib/repositories/growth.repo";

import { encryptionAvailable } from "./crypto";

/**
 * Google Ads integration.
 *
 * STATUS: NOT CONNECTED. There is no Google Ads account for the agency yet, so
 * this module is a complete, typed interface with a disabled state: every method
 * reports `connected: false` and throws `IntegrationDisabledError` rather than
 * returning fabricated data.
 *
 * When the account exists, only this file changes — the campaign model, budget
 * guards, change log and reporting already exist in the platform:
 *
 *   1. Create a Google Ads account + developer token.
 *   2. Create an OAuth client and set GOOGLE_ADS_CLIENT_ID / _SECRET.
 *   3. Complete the OAuth consent flow, store the refresh token encrypted
 *      (GOOGLE_ADS_REFRESH_TOKEN or the integration_connections table).
 *   4. Set GOOGLE_ADS_ENABLED=true, GOOGLE_ADS_LOGIN_CUSTOMER_ID=…
 *   5. `npm run db:migrate` is not required — no schema change is needed.
 *
 * Safety limits enforced by the platform (not by Google) and re-checked here:
 *   allowed automatically → pause a weak ad, tighten keywords/copy, shift budget
 *                           inside the agreed envelope, narrow targeting.
 *   never allowed        → raise the total budget, exceed daily/monthly caps,
 *                           change the payment method, create a spending
 *                           campaign, change strategy without approval.
 */
export interface GoogleAdsStatus {
  connected: boolean;
  enabled: boolean;
  reasonAr: string;
  reasonEn: string;
  setupStepsAr: string[];
  setupStepsEn: string[];
  missingConfig: string[];
  apiVersion: string;
  loginCustomerId: string | null;
}

export function googleAdsStatus(): GoogleAdsStatus {
  const env = getEnv();
  const missing: string[] = [];
  if (!env.googleAds.enabled) missing.push("GOOGLE_ADS_ENABLED=true");
  if (!env.googleAds.developerToken) missing.push("GOOGLE_ADS_DEVELOPER_TOKEN");
  if (!env.googleAds.clientId) missing.push("GOOGLE_ADS_CLIENT_ID");
  if (!env.googleAds.clientSecret) missing.push("GOOGLE_ADS_CLIENT_SECRET");
  if (!env.googleAds.refreshToken) missing.push("GOOGLE_ADS_REFRESH_TOKEN");
  if (!env.googleAds.loginCustomerId) missing.push("GOOGLE_ADS_LOGIN_CUSTOMER_ID");
  if (!encryptionAvailable()) missing.push("APP_ENCRYPTION_KEY");

  return {
    connected: false,
    enabled: env.googleAds.enabled,
    reasonAr:
      "تكامل Google Ads غير مربوط بعد. لا يوجد حساب إعلانات للوكالة حاليًا، لذلك يبقى التكامل متوقفًا ولا يعرض أي أرقام غير حقيقية.",
    reasonEn:
      "The Google Ads integration is not connected. The agency has no ads account yet, so the integration stays disabled and never shows fabricated numbers.",
    setupStepsAr: [
      "أنشئ حساب Google Ads للوكالة واحصل على developer token.",
      "أنشئ بيانات OAuth وأضف GOOGLE_ADS_CLIENT_ID و GOOGLE_ADS_CLIENT_SECRET في .env.",
      "أكمل ربط الحساب لتوليد refresh token، ثم ضعه في GOOGLE_ADS_REFRESH_TOKEN (يُخزَّن مشفّرًا).",
      "أضف APP_ENCRYPTION_KEY لتشفير الرموز، ثم اجعل GOOGLE_ADS_ENABLED=true.",
      "أدخل رقم الحساب في GOOGLE_ADS_LOGIN_CUSTOMER_ID.",
    ],
    setupStepsEn: [
      "Create a Google Ads account for the agency and obtain a developer token.",
      "Create OAuth credentials and set GOOGLE_ADS_CLIENT_ID and GOOGLE_ADS_CLIENT_SECRET in .env.",
      "Complete the account link to obtain a refresh token and store it in GOOGLE_ADS_REFRESH_TOKEN (encrypted at rest).",
      "Set APP_ENCRYPTION_KEY so tokens can be encrypted, then set GOOGLE_ADS_ENABLED=true.",
      "Put the account id in GOOGLE_ADS_LOGIN_CUSTOMER_ID.",
    ],
    missingConfig: missing,
    apiVersion: env.googleAds.apiVersion,
    loginCustomerId: env.googleAds.loginCustomerId || null,
  };
}

export function googleAdsConnected(): boolean {
  return googleAdsStatus().connected;
}

function requireConnection(operation: string): never {
  const status = googleAdsStatus();
  throw new IntegrationDisabledError("google_ads", status.reasonEn, {
    operation,
    missingConfig: status.missingConfig,
  });
}

/** Plans a campaign locally (works without Google); nothing is pushed yet. */
export interface CampaignPlanSuggestion {
  suggestedKeywords: { keyword: string; matchType: "BROAD" | "PHRASE" | "EXACT"; rationale: string }[];
  suggestedAudiences: { name: string; rationale: string }[];
  suggestedDailyBudgetMinor: number;
  suggestedAdCopy: { headline: string; body: string }[];
  notesAr: string[];
  notesEn: string[];
}

export interface PlanInput {
  objective: string;
  country: string | null;
  language: Locale;
  currency: string;
  totalBudgetMinor: number;
  days: number;
  brand: string;
  services: string[];
}

/**
 * Produces a structured plan proposal. This runs locally and is explicitly
 * labelled as a proposal, because no Google Ads account exists to validate
 * keyword volume or bids against.
 */
export function planCampaign(input: PlanInput): CampaignPlanSuggestion {
  const dailyBudget = input.days > 0 ? Math.max(100, Math.round(input.totalBudgetMinor / input.days)) : 1_000;
  const base = input.services.length > 0 ? input.services : ["digital marketing"];
  const keywords = base.flatMap((service) => [
    {
      keyword: `${service} ${input.country ? input.country.toLowerCase() : ""}`.trim(),
      matchType: "PHRASE" as const,
      rationale: "خدمة محددة مع السوق المستهدف: نية شراء واضحة.",
    },
    {
      keyword: `${service}`,
      matchType: "BROAD" as const,
      rationale: "كلمة عامة لاستكشاف الطلبات الجديدة.",
    },
  ]);

  return {
    suggestedKeywords: keywords.slice(0, 12),
    suggestedAudiences: [
      {
        name: input.country ? `Interests & in-market: ${input.country}` : "In-market: your industry",
        rationale: "جمهور مهتم فعليًا بالخدمة، وليس مجرد اهتمام عام.",
      },
      {
        name: "Remarketing (website visitors)",
        rationale: "من زار الموقع ولم يُكمل الطلب عادة يكون الأرخص في التحويل.",
      },
    ],
    suggestedDailyBudgetMinor: dailyBudget,
    suggestedAdCopy: [
      {
        headline: input.language === "ar" ? "ابدأ حملتك مع أفق" : "Grow with Ofoq",
        body:
          input.language === "ar"
            ? "فريق تسويق يدير حملاتك بمتابعة يومية وتقارير واضحة."
            : "A marketing team that runs your campaigns with daily follow-up and clear reports.",
      },
    ],
    notesAr: [
      "هذا الاقتراح مبني على سياسة الوكالة الداخلية وليس على بيانات حساب حقيقي، لأن حساب Google Ads غير مربوط بعد.",
      "لن يُنفق أي مبلغ قبل موافقتك وتحديد الحد اليومي والشهري.",
      "بعد الربط ستُستبدل هذه القائمة بأرقام حقيقية (حجم البحث والمنافسة).",
    ],
    notesEn: [
      "This proposal follows the agency's internal policy — not real account data, because no Google Ads account is connected yet.",
      "Nothing is spent before your approval and before the daily/monthly caps are agreed.",
      "Once connected, this list will be replaced with real search volume and competition data.",
    ],
  };
}

/** Pulls daily metrics from Google Ads. Requires a connected account. */
export async function syncCampaignMetrics(_input: {
  campaign: CampaignRow;
  fromDate: string;
  toDate: string;
}): Promise<CampaignMetricsRow[]> {
  if (!googleAdsConnected()) {
    logger.info("Google Ads sync skipped (not connected)", { campaignId: _input.campaign.id });
    requireConnection("sync_metrics");
  }
  return [];
}

/**
 * Operational improvements the agent may apply ITSELF once connected.
 * Every call is validated against the campaign's agreed limits by the caller.
 */
export interface OptimizationProposal {
  changeType: string;
  reasonAr: string;
  reasonEn: string;
  payload: Record<string, unknown>;
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  autoApplicable: boolean;
}

export function proposeOptimizations(input: {
  campaign: CampaignRow;
  metrics: CampaignMetricsRow[];
  limits: { weakCtrThreshold: number; minImpressionsBeforePause: number; allowAutoPause: boolean; allowAutoCopyChanges: boolean };
}): OptimizationProposal[] {
  const proposals: OptimizationProposal[] = [];
  const totals = input.metrics.reduce(
    (accumulator, row) => ({
      impressions: accumulator.impressions + row.impressions,
      clicks: accumulator.clicks + row.clicks,
      cost: accumulator.cost + row.cost_minor,
    }),
    { impressions: 0, clicks: 0, cost: 0 },
  );
  const ctr = totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : 0;

  if (
    totals.impressions >= input.limits.minImpressionsBeforePause &&
    ctr < input.limits.weakCtrThreshold &&
    input.limits.allowAutoPause
  ) {
    proposals.push({
      changeType: "PAUSE_WEAK_AD",
      reasonAr: `نسبة النقر ${ctr.toFixed(2)}% أقل من الحد المتفق عليه. إيقاف الإعلان الضعيف يوفّر الميزانية.`,
      reasonEn: `CTR ${ctr.toFixed(2)}% is below the agreed threshold. Pausing the weak ad protects the budget.`,
      payload: { ctr, impressions: totals.impressions, clicks: totals.clicks },
      riskLevel: "LOW",
      autoApplicable: true,
    });
  }

  if (totals.cost > 0 && totals.clicks === 0 && input.limits.allowAutoCopyChanges) {
    proposals.push({
      changeType: "IMPROVE_AD_COPY",
      reasonAr: "تم صرف ميزانية بلا نقرات. سنقترح نصًا أوضح يبدأ بالفائدة الأساسية.",
      reasonEn: "Budget was spent with no clicks. We will propose clearer copy that leads with the main benefit.",
      payload: { cost: totals.cost },
      riskLevel: "LOW",
      autoApplicable: false,
    });
  }

  return proposals;
}

/** Explicitly documents what the integration may never do. */
export const GOOGLE_ADS_FORBIDDEN_ACTIONS = [
  "raise_total_budget",
  "exceed_daily_cap",
  "exceed_monthly_cap",
  "change_payment_method",
  "create_spending_campaign",
  "change_core_strategy_without_approval",
] as const;

export type GoogleAdsForbiddenAction = (typeof GOOGLE_ADS_FORBIDDEN_ACTIONS)[number];
