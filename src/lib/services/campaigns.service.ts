import { daysBetween, nowIso, toDateKey } from "@/lib/core/date";
import { ConflictError, NotFoundError, PreconditionError, ValidationError } from "@/lib/core/errors";
import { formatMoney } from "@/lib/core/money";
import type {
  CampaignPlatform,
  CampaignRow,
  CampaignStatus,
  CustomerRow,
  Locale,
  RiskLevel,
} from "@/lib/domain/types";
import {
  createCampaign,
  findCampaignById,
  listCampaignChanges,
  listCampaignMetrics,
  listCampaigns,
  recordCampaignChange,
  setCampaignSyncStatus,
  updateCampaign,
} from "@/lib/repositories/growth.repo";

import { logActivity } from "./activity.service";
import { raiseAlert } from "./alerts.service";

/**
 * Campaign management and the ad-spend safety envelope.
 *
 * The platform never spends money by itself. What it can do is keep campaigns
 * inside limits that a human agreed to, and record every change:
 *
 *   ALLOWED automatically   → pause a weak ad, improve copy/keywords, shift
 *                             budget *between* ad sets inside the agreed total,
 *                             adjust targeting within a narrow band.
 *   NEVER allowed           → increase the total budget, exceed the daily or
 *                             monthly cap, change the payment method, create a
 *                             new campaign that spends money, change the core
 *                             strategy without approval.
 */
export interface SafeLimits {
  maxDailyBudgetMinor: number;
  maxMonthlyBudgetMinor: number;
  maxTotalBudgetMinor: number;
  /** How much of the monthly budget the agent may move around (percent). */
  maxBudgetShiftPercent: number;
  /** Minimum clicks before the agent may pause an ad on its own. */
  minImpressionsBeforePause: number;
  /** A click-through rate below this marks an ad as weak. */
  weakCtrThreshold: number;
  allowAutoPause: boolean;
  allowAutoCopyChanges: boolean;
}

export const DEFAULT_SAFE_LIMITS: SafeLimits = {
  maxDailyBudgetMinor: 10_000, // 100.00 of the campaign currency
  maxMonthlyBudgetMinor: 200_000,
  maxTotalBudgetMinor: 1_000_000,
  maxBudgetShiftPercent: 20,
  minImpressionsBeforePause: 1_000,
  weakCtrThreshold: 0.5, // percent
  allowAutoPause: true,
  allowAutoCopyChanges: true,
};

export function parseSafeLimits(value: string | null | undefined): SafeLimits {
  if (!value) return DEFAULT_SAFE_LIMITS;
  try {
    const parsed = JSON.parse(value) as Partial<SafeLimits>;
    return { ...DEFAULT_SAFE_LIMITS, ...parsed };
  } catch {
    return DEFAULT_SAFE_LIMITS;
  }
}

export interface CreateCampaignInput {
  customer: CustomerRow;
  name: string;
  platform: CampaignPlatform;
  objective?: string | null;
  currency?: string;
  totalBudgetMinor: number;
  dailyBudgetMinor: number;
  monthlyBudgetMinor: number;
  startDate?: string | null;
  endDate?: string | null;
  targeting?: unknown;
  keywords?: unknown;
  adCopy?: unknown;
  projectId?: string | null;
  actorUserId?: string | null;
  actorAgent?: string | null;
  autopilot?: boolean;
  safeLimits?: Partial<SafeLimits>;
  isDemo?: number;
}

export async function createCampaignForCustomer(input: CreateCampaignInput): Promise<CampaignRow> {
  if (input.totalBudgetMinor <= 0) throw new ValidationError("The total budget must be greater than zero");
  if (input.dailyBudgetMinor > input.totalBudgetMinor) {
    throw new ValidationError("The daily budget cannot exceed the total budget");
  }
  if (input.monthlyBudgetMinor > input.totalBudgetMinor) {
    throw new ValidationError("The monthly budget cannot exceed the total budget");
  }

  const limits: SafeLimits = { ...DEFAULT_SAFE_LIMITS, ...(input.safeLimits ?? {}) };

  const campaign = await createCampaign({
    customer_id: input.customer.id,
    project_id: input.projectId ?? null,
    platform: input.platform,
    name: input.name,
    objective: input.objective ?? null,
    status: "DRAFT",
    currency: input.currency ?? input.customer.currency,
    total_budget_minor: input.totalBudgetMinor,
    daily_budget_minor: input.dailyBudgetMinor,
    monthly_budget_minor: input.monthlyBudgetMinor,
    start_date: input.startDate ?? null,
    end_date: input.endDate ?? null,
    targeting: input.targeting ? JSON.stringify(input.targeting) : null,
    keywords: input.keywords ? JSON.stringify(input.keywords) : null,
    ad_copy: input.adCopy ? JSON.stringify(input.adCopy) : null,
    autopilot_enabled: input.autopilot ? 1 : 0,
    safe_limits: JSON.stringify(limits),
    // Nothing is synced until the platform integration is genuinely connected.
    sync_status: "NOT_CONNECTED",
    created_by_agent: input.actorAgent ?? null,
    created_by_user_id: input.actorUserId ?? null,
    is_demo: input.isDemo ?? 0,
  });

  await recordCampaignChange({
    campaign_id: campaign.id,
    change_type: "CAMPAIGN_CREATED",
    agent_key: input.actorAgent ?? null,
    after_state: { name: campaign.name, totalBudgetMinor: campaign.total_budget_minor },
    reason: "Campaign plan created",
    risk_level: "MEDIUM",
    auto_applied: Boolean(input.actorAgent),
  });

  await logActivity({
    actor_type: input.actorUserId ? "USER" : input.actorAgent ? "AGENT" : "SYSTEM",
    actor_user_id: input.actorUserId ?? null,
    actor_label: input.actorAgent ?? null,
    action: "campaign.created",
    entity_type: "campaign",
    entity_id: campaign.id,
    customer_id: input.customer.id,
    summary: `Campaign "${campaign.name}" created (${campaign.platform})`,
    meta: {
      totalBudgetMinor: campaign.total_budget_minor,
      dailyBudgetMinor: campaign.daily_budget_minor,
    },
  });

  return campaign;
}

export async function activateCampaign(
  campaignId: string,
  actor: { userId?: string | null; agentKey?: string | null },
): Promise<CampaignRow> {
  const campaign = await findCampaignById(campaignId);
  if (!campaign) throw new NotFoundError("Campaign not found");
  if (campaign.status === "ACTIVE") return campaign;
  if (!campaign.start_date || !campaign.end_date) {
    throw new PreconditionError("A campaign needs a start and end date before it can be activated");
  }

  const updated = await updateCampaign(campaignId, { status: "ACTIVE" });
  await recordCampaignChange({
    campaign_id: campaignId,
    change_type: "STATUS_CHANGED",
    agent_key: actor.agentKey ?? null,
    before_state: { status: campaign.status },
    after_state: { status: "ACTIVE" },
    reason: "Activated by a human decision",
    risk_level: "MEDIUM",
    auto_applied: false,
    approver_user_id: actor.userId ?? null,
  });

  await logActivity({
    actor_type: actor.userId ? "USER" : "AGENT",
    actor_user_id: actor.userId ?? null,
    actor_label: actor.agentKey ?? null,
    action: "campaign.activated",
    entity_type: "campaign",
    entity_id: campaignId,
    customer_id: campaign.customer_id,
    summary: `Campaign "${campaign.name}" activated`,
  });

  return updated!;
}

export async function pauseCampaign(
  campaignId: string,
  actor: { userId?: string | null; agentKey?: string | null; reason: string },
): Promise<CampaignRow> {
  const campaign = await findCampaignById(campaignId);
  if (!campaign) throw new NotFoundError("Campaign not found");

  const updated = await updateCampaign(campaignId, { status: "PAUSED" });
  await recordCampaignChange({
    campaign_id: campaignId,
    change_type: "STATUS_CHANGED",
    agent_key: actor.agentKey ?? null,
    before_state: { status: campaign.status },
    after_state: { status: "PAUSED" },
    reason: actor.reason,
    risk_level: "LOW",
    auto_applied: Boolean(actor.agentKey),
  });

  await logActivity({
    actor_type: actor.userId ? "USER" : "AGENT",
    actor_user_id: actor.userId ?? null,
    actor_label: actor.agentKey ?? null,
    action: "campaign.paused",
    entity_type: "campaign",
    entity_id: campaignId,
    customer_id: campaign.customer_id,
    summary: `Campaign "${campaign.name}" paused — ${actor.reason}`,
  });

  return updated!;
}

/**
 * Budget change guard.
 *
 * The agent may only *redistribute* budget inside the agreed envelope. Any
 * increase of the total, daily or monthly cap is rejected here regardless of who
 * asks, unless a human owner/partner explicitly approves it via `allowIncrease`.
 */
export async function changeCampaignBudget(
  campaignId: string,
  next: { totalBudgetMinor?: number; dailyBudgetMinor?: number; monthlyBudgetMinor?: number },
  actor: { userId?: string | null; agentKey?: string | null; reason: string; allowIncrease?: boolean },
): Promise<CampaignRow> {
  const campaign = await findCampaignById(campaignId);
  if (!campaign) throw new NotFoundError("Campaign not found");
  const limits = parseSafeLimits(campaign.safe_limits);
  const isAgent = Boolean(actor.agentKey) && !actor.userId;

  const violates = (current: number, requested: number | undefined, enforce: boolean): boolean => {
    if (requested === undefined) return false;
    if (requested <= current) return false;
    return isAgent || enforce;
  };

  if (violates(campaign.total_budget_minor, next.totalBudgetMinor, !actor.allowIncrease)) {
    throw new ConflictError(
      "Increasing the total budget requires explicit owner/partner approval and can never be done by an agent.",
    );
  }
  if (violates(campaign.daily_budget_minor, next.dailyBudgetMinor, !actor.allowIncrease)) {
    throw new ConflictError("Increasing the daily cap requires explicit approval.");
  }
  if (violates(campaign.monthly_budget_minor, next.monthlyBudgetMinor, !actor.allowIncrease)) {
    throw new ConflictError("Increasing the monthly cap requires explicit approval.");
  }

  const daily = next.dailyBudgetMinor ?? campaign.daily_budget_minor;
  const monthly = next.monthlyBudgetMinor ?? campaign.monthly_budget_minor;
  const total = next.totalBudgetMinor ?? campaign.total_budget_minor;

  if (daily > limits.maxDailyBudgetMinor && daily > campaign.daily_budget_minor) {
    throw new ConflictError(
      `The daily budget exceeds the configured safe limit (${formatMoney(limits.maxDailyBudgetMinor, campaign.currency, "en")}).`,
    );
  }
  if (monthly > limits.maxMonthlyBudgetMinor && monthly > campaign.monthly_budget_minor) {
    throw new ConflictError("The monthly budget exceeds the configured safe limit.");
  }
  if (daily > total || monthly > total) {
    throw new ValidationError("Daily and monthly budgets must stay within the total budget");
  }

  const updated = await updateCampaign(campaignId, {
    total_budget_minor: total,
    daily_budget_minor: daily,
    monthly_budget_minor: monthly,
  });

  await recordCampaignChange({
    campaign_id: campaignId,
    change_type: "BUDGET_CHANGED",
    agent_key: actor.agentKey ?? null,
    before_state: {
      totalBudgetMinor: campaign.total_budget_minor,
      dailyBudgetMinor: campaign.daily_budget_minor,
      monthlyBudgetMinor: campaign.monthly_budget_minor,
    },
    after_state: {
      totalBudgetMinor: total,
      dailyBudgetMinor: daily,
      monthlyBudgetMinor: monthly,
    },
    reason: actor.reason,
    risk_level: isAgent ? "MEDIUM" : "LOW",
    auto_applied: isAgent,
    within_limits: true,
    approver_user_id: actor.userId ?? null,
  });

  await logActivity({
    actor_type: actor.userId ? "USER" : "AGENT",
    actor_user_id: actor.userId ?? null,
    actor_label: actor.agentKey ?? null,
    action: "campaign.budget_changed",
    entity_type: "campaign",
    entity_id: campaignId,
    customer_id: campaign.customer_id,
    summary: `Campaign "${campaign.name}" budget updated — ${actor.reason}`,
    meta: { before: campaign.total_budget_minor, after: total },
  });

  return updated!;
}

/** Suggests (but does not perform) changes that need human approval. */
export async function suggestCampaignChange(
  campaignId: string,
  suggestion: {
    changeType: string;
    reason: string;
    payload: Record<string, unknown>;
    riskLevel?: RiskLevel;
    agentKey?: string;
  },
): Promise<string> {
  const campaign = await findCampaignById(campaignId);
  if (!campaign) throw new NotFoundError("Campaign not found");

  const change = await recordCampaignChange({
    campaign_id: campaignId,
    change_type: suggestion.changeType,
    agent_key: suggestion.agentKey ?? null,
    after_state: suggestion.payload,
    reason: suggestion.reason,
    risk_level: suggestion.riskLevel ?? "MEDIUM",
    auto_applied: false,
    within_limits: false,
  });

  await raiseAlert({
    severity: "IMPORTANT",
    category: "campaigns",
    title_ar: `اقتراح تحسين لحملة ${campaign.name}`,
    title_en: `Optimisation suggestion for ${campaign.name}`,
    body_ar: `${suggestion.reason}\nالاقتراح مسجل وينتظر موافقتك.`,
    body_en: `${suggestion.reason}\nThe suggestion is recorded and waiting for your approval.`,
    entity_type: "campaign_change",
    entity_id: change.id,
    customer_id: campaign.customer_id,
    dedupe_key: `campaign-suggestion:${change.id}`,
  });

  return change.id;
}

/** Records what was actually spent (manual entry or a future API sync). */
export async function setCampaignSpend(
  campaignId: string,
  spentMinor: number,
  actorUserId?: string | null,
): Promise<void> {
  const campaign = await findCampaignById(campaignId);
  if (!campaign) throw new NotFoundError("Campaign not found");
  if (spentMinor < 0) throw new ValidationError("Spend cannot be negative");

  const spent = Math.min(spentMinor, campaign.total_budget_minor);
  await updateCampaign(campaignId, { spent_minor: spent });
  await logActivity({
    actor_type: actorUserId ? "USER" : "SYSTEM",
    actor_user_id: actorUserId ?? null,
    action: "campaign.spend_recorded",
    entity_type: "campaign",
    entity_id: campaignId,
    customer_id: campaign.customer_id,
    summary: `Spend recorded for "${campaign.name}": ${formatMoney(spent, campaign.currency, "en")}`,
  });
}

export interface CampaignBudgetState {
  totalMinor: number;
  spentMinor: number;
  remainingMinor: number;
  dailyCapMinor: number;
  monthlyCapMinor: number;
  daysRunning: number;
  daysRemaining: number | null;
  burnRatePercent: number;
  pacingWarning: string | null;
}

export function budgetState(campaign: CampaignRow): CampaignBudgetState {
  const spent = campaign.spent_minor;
  const remaining = Math.max(0, campaign.total_budget_minor - spent);
  const daysRunning = campaign.start_date ? Math.max(0, daysBetween(campaign.start_date, new Date())) : 0;
  const daysRemaining = campaign.end_date ? daysBetween(new Date(), campaign.end_date) : null;
  const burnRate = campaign.total_budget_minor === 0 ? 0 : Math.round((spent / campaign.total_budget_minor) * 100);

  let pacingWarning: string | null = null;
  if (campaign.status === "ACTIVE" && campaign.total_budget_minor > 0) {
    if (burnRate > 90 && daysRemaining !== null && daysRemaining > 3) {
      pacingWarning = "الميزانية استُهلكت أسرع من المدة المتبقية.";
    } else if (burnRate < 20 && daysRunning > 14) {
      pacingWarning = "الإنفاق أقل من المتوقع مقارنة بالمدة المنقضية.";
    }
  }

  return {
    totalMinor: campaign.total_budget_minor,
    spentMinor: spent,
    remainingMinor: remaining,
    dailyCapMinor: campaign.daily_budget_minor,
    monthlyCapMinor: campaign.monthly_budget_minor,
    daysRunning,
    daysRemaining,
    burnRatePercent: burnRate,
    pacingWarning,
  };
}

export async function campaignDetails(campaignId: string, locale: Locale) {
  const campaign = await findCampaignById(campaignId);
  if (!campaign) throw new NotFoundError("Campaign not found");
  const metrics = await listCampaignMetrics(campaignId, { limit: 30 });
  const changes = await listCampaignChanges(campaignId, 20);
  return {
    campaign,
    metrics,
    changes,
    budget: budgetState(campaign),
    limits: parseSafeLimits(campaign.safe_limits),
    locale,
  };
}

export async function listActiveCampaignsForCustomer(
  customerId: string,
  statuses: CampaignStatus[] = ["ACTIVE", "PAUSED"],
): Promise<CampaignRow[]> {
  const { rows } = await listCampaigns({ customerId, status: statuses, limit: 50 });
  return rows;
}

export async function markCampaignSyncDisabled(campaignId: string): Promise<void> {
  await setCampaignSyncStatus(campaignId, "NOT_CONNECTED");
}

export function todayKey(): string {
  return toDateKey(new Date());
}

export function assertCampaignSpendWithinCaps(campaign: CampaignRow, additionalSpendMinor: number): void {
  const state = budgetState(campaign);
  const next = state.spentMinor + additionalSpendMinor;
  if (next > campaign.total_budget_minor) {
    throw new ConflictError("This spend would exceed the agreed total budget for the campaign.");
  }
  if (next > campaign.monthly_budget_minor && campaign.monthly_budget_minor > 0) {
    throw new ConflictError("This spend would exceed the agreed monthly cap for the campaign.");
  }
  void nowIso();
}
