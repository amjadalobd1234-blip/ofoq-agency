import { getDb } from "@/lib/db";
import type { DbDriver } from "@/lib/db/types";
import type {
  CampaignChangeRow,
  CampaignMetricsRow,
  CampaignPlatform,
  CampaignRow,
  CampaignStatus,
  CampaignWithCustomer,
  ReportRow,
  ReportType,
  RiskLevel,
  SyncStatus,
} from "@/lib/domain/types";
import { nowIso } from "@/lib/core/date";

import { clean, findRowById, insertRow, updateRow } from "./base";

/* ---------------------------------------------------------------- campaigns */

export async function createCampaign(
  data: Partial<CampaignRow> & { customer_id: string; name: string; platform: CampaignPlatform },
  db?: DbDriver,
): Promise<CampaignRow> {
  const timestamp = nowIso();
  const row: CampaignRow = {
    id: data.id ?? crypto.randomUUID(),
    customer_id: data.customer_id,
    project_id: data.project_id ?? null,
    platform: data.platform,
    external_id: data.external_id ?? null,
    name: data.name,
    objective: data.objective ?? null,
    status: data.status ?? "DRAFT",
    currency: data.currency ?? "USD",
    total_budget_minor: data.total_budget_minor ?? 0,
    daily_budget_minor: data.daily_budget_minor ?? 0,
    monthly_budget_minor: data.monthly_budget_minor ?? 0,
    spent_minor: data.spent_minor ?? 0,
    start_date: data.start_date ?? null,
    end_date: data.end_date ?? null,
    targeting: data.targeting ?? null,
    keywords: data.keywords ?? null,
    ad_copy: data.ad_copy ?? null,
    autopilot_enabled: data.autopilot_enabled ?? 0,
    safe_limits: data.safe_limits ?? null,
    sync_status: data.sync_status ?? "DISABLED",
    last_sync_at: data.last_sync_at ?? null,
    created_by_agent: data.created_by_agent ?? null,
    created_by_user_id: data.created_by_user_id ?? null,
    is_demo: data.is_demo ?? 0,
    created_at: timestamp,
    updated_at: timestamp,
  };
  await insertRow("campaigns", row, db);
  return row;
}

export async function updateCampaign(
  id: string,
  data: Partial<CampaignRow>,
  db?: DbDriver,
): Promise<CampaignRow | undefined> {
  return updateRow<CampaignRow>("campaigns", id, { ...clean(data), updated_at: nowIso() }, db);
}

export async function findCampaignById(id: string, db?: DbDriver): Promise<CampaignRow | undefined> {
  return findRowById<CampaignRow>("campaigns", id, db);
}

export async function listCampaigns(
  filter: {
    customerId?: string;
    platform?: CampaignPlatform;
    status?: CampaignStatus[];
    limit?: number;
    offset?: number;
  } = {},
  db?: DbDriver,
): Promise<{ rows: CampaignWithCustomer[]; total: number }> {
  const driver = db ?? (await getDb());
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (filter.customerId) {
    clauses.push("k.customer_id = ?");
    params.push(filter.customerId);
  }
  if (filter.platform) {
    clauses.push("k.platform = ?");
    params.push(filter.platform);
  }
  if (filter.status?.length) {
    clauses.push(`k.status IN (${filter.status.map(() => "?").join(", ")})`);
    params.push(...filter.status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const totalRow = await driver.get<{ total: number }>(
    `SELECT COUNT(*) AS total FROM campaigns k ${where}`,
    params,
  );
  const rows = await driver.query<CampaignWithCustomer>(
    `SELECT k.*, c.contact_name AS customer_name
     FROM campaigns k JOIN customers c ON c.id = k.customer_id
     ${where} ORDER BY k.created_at DESC LIMIT ? OFFSET ?`,
    [...params, filter.limit ?? 50, filter.offset ?? 0],
  );
  return { rows, total: Number(totalRow?.total ?? 0) };
}

export async function listActiveCampaigns(db?: DbDriver): Promise<CampaignWithCustomer[]> {
  const driver = db ?? (await getDb());
  return driver.query<CampaignWithCustomer>(
    `SELECT k.*, c.contact_name AS customer_name
     FROM campaigns k JOIN customers c ON c.id = k.customer_id
     WHERE k.status = 'ACTIVE' ORDER BY k.created_at`,
  );
}

export async function setCampaignSyncStatus(
  id: string,
  status: SyncStatus,
  externalId?: string | null,
  db?: DbDriver,
): Promise<void> {
  const driver = db ?? (await getDb());
  await driver.run(
    "UPDATE campaigns SET sync_status = ?, external_id = COALESCE(?, external_id), last_sync_at = ?, updated_at = ? WHERE id = ?",
    [status, externalId ?? null, nowIso(), nowIso(), id],
  );
}

/* ------------------------------------------------------------ daily metrics */

export async function upsertCampaignMetrics(
  data: {
    campaign_id: string;
    metric_date: string;
    impressions?: number;
    clicks?: number;
    cost_minor?: number;
    conversions?: number;
    conversion_value_minor?: number;
    source?: CampaignMetricsRow["source"];
    raw?: unknown;
  },
  db?: DbDriver,
): Promise<CampaignMetricsRow> {
  const driver = db ?? (await getDb());
  const impressions = data.impressions ?? 0;
  const clicks = data.clicks ?? 0;
  const cost = data.cost_minor ?? 0;
  const conversions = data.conversions ?? 0;
  const ctr = impressions > 0 ? Number(((clicks / impressions) * 100).toFixed(4)) : null;
  const cpc = clicks > 0 ? Math.round(cost / clicks) : null;
  const cpa = conversions > 0 ? Math.round(cost / conversions) : null;

  const existing = await driver.get<CampaignMetricsRow>(
    "SELECT * FROM campaign_metrics_daily WHERE campaign_id = ? AND metric_date = ?",
    [data.campaign_id, data.metric_date],
  );

  if (existing) {
    await driver.run(
      `UPDATE campaign_metrics_daily
       SET impressions = ?, clicks = ?, cost_minor = ?, conversions = ?, conversion_value_minor = ?,
           ctr = ?, cpc_minor = ?, cpa_minor = ?, source = ?, raw = ?
       WHERE id = ?`,
      [
        impressions,
        clicks,
        cost,
        conversions,
        data.conversion_value_minor ?? 0,
        ctr,
        cpc,
        cpa,
        data.source ?? "MANUAL",
        data.raw === undefined ? null : JSON.stringify(data.raw),
        existing.id,
      ],
    );
    return (await findMetricsRow(existing.id, driver))!;
  }

  const row: CampaignMetricsRow = {
    id: crypto.randomUUID(),
    campaign_id: data.campaign_id,
    metric_date: data.metric_date,
    impressions,
    clicks,
    cost_minor: cost,
    conversions,
    conversion_value_minor: data.conversion_value_minor ?? 0,
    ctr,
    cpc_minor: cpc,
    cpa_minor: cpa,
    source: data.source ?? "MANUAL",
    raw: data.raw === undefined ? null : JSON.stringify(data.raw),
    created_at: nowIso(),
  };
  await insertRow("campaign_metrics_daily", row, driver);
  return row;
}

async function findMetricsRow(id: string, db?: DbDriver): Promise<CampaignMetricsRow | undefined> {
  return findRowById<CampaignMetricsRow>("campaign_metrics_daily", id, db);
}

export async function listCampaignMetrics(
  campaignId: string,
  options: { fromDate?: string; toDate?: string; limit?: number } = {},
  db?: DbDriver,
): Promise<CampaignMetricsRow[]> {
  const driver = db ?? (await getDb());
  const clauses = ["campaign_id = ?"];
  const params: (string | number)[] = [campaignId];
  if (options.fromDate) {
    clauses.push("metric_date >= ?");
    params.push(options.fromDate);
  }
  if (options.toDate) {
    clauses.push("metric_date <= ?");
    params.push(options.toDate);
  }
  const rows = await driver.query<CampaignMetricsRow>(
    `SELECT * FROM campaign_metrics_daily WHERE ${clauses.join(" AND ")}
     ORDER BY metric_date DESC LIMIT ?`,
    [...params, options.limit ?? 90],
  );
  return rows.reverse();
}

export interface MetricsTotals {
  impressions: number;
  clicks: number;
  cost_minor: number;
  conversions: number;
  conversion_value_minor: number;
}

export async function aggregateMetrics(
  filter: { campaignId?: string; customerId?: string; fromDate?: string; toDate?: string },
  db?: DbDriver,
): Promise<MetricsTotals> {
  const driver = db ?? (await getDb());
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (filter.campaignId) {
    clauses.push("m.campaign_id = ?");
    params.push(filter.campaignId);
  }
  if (filter.customerId) {
    clauses.push("k.customer_id = ?");
    params.push(filter.customerId);
  }
  if (filter.fromDate) {
    clauses.push("m.metric_date >= ?");
    params.push(filter.fromDate);
  }
  if (filter.toDate) {
    clauses.push("m.metric_date <= ?");
    params.push(filter.toDate);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const row = await driver.get<{
    impressions: number | null;
    clicks: number | null;
    cost_minor: number | null;
    conversions: number | null;
    conversion_value_minor: number | null;
  }>(
    `SELECT SUM(m.impressions) AS impressions, SUM(m.clicks) AS clicks, SUM(m.cost_minor) AS cost_minor,
            SUM(m.conversions) AS conversions, SUM(m.conversion_value_minor) AS conversion_value_minor
     FROM campaign_metrics_daily m
     JOIN campaigns k ON k.id = m.campaign_id
     ${where}`,
    params,
  );
  return {
    impressions: Number(row?.impressions ?? 0),
    clicks: Number(row?.clicks ?? 0),
    cost_minor: Number(row?.cost_minor ?? 0),
    conversions: Number(row?.conversions ?? 0),
    conversion_value_minor: Number(row?.conversion_value_minor ?? 0),
  };
}

/* ------------------------------------------------------------ campaign changes */

export async function recordCampaignChange(
  data: {
    campaign_id: string;
    change_type: string;
    agent_key?: string | null;
    before_state?: unknown;
    after_state?: unknown;
    reason?: string | null;
    risk_level?: RiskLevel;
    auto_applied?: boolean;
    within_limits?: boolean;
    approver_user_id?: string | null;
  },
  db?: DbDriver,
): Promise<CampaignChangeRow> {
  const row: CampaignChangeRow = {
    id: crypto.randomUUID(),
    campaign_id: data.campaign_id,
    agent_key: data.agent_key ?? null,
    change_type: data.change_type,
    before_state: data.before_state === undefined ? null : JSON.stringify(data.before_state),
    after_state: data.after_state === undefined ? null : JSON.stringify(data.after_state),
    reason: data.reason ?? null,
    risk_level: data.risk_level ?? "LOW",
    auto_applied: data.auto_applied ? 1 : 0,
    within_limits: data.within_limits === false ? 0 : 1,
    approver_user_id: data.approver_user_id ?? null,
    applied_at: data.auto_applied ? nowIso() : null,
    created_at: nowIso(),
  };
  await insertRow("campaign_changes", row, db);
  return row;
}

export async function listCampaignChanges(
  campaignId: string,
  limit = 50,
  db?: DbDriver,
): Promise<CampaignChangeRow[]> {
  const driver = db ?? (await getDb());
  return driver.query<CampaignChangeRow>(
    "SELECT * FROM campaign_changes WHERE campaign_id = ? ORDER BY created_at DESC LIMIT ?",
    [campaignId, limit],
  );
}

export async function listRecentCampaignChanges(
  sinceIso: string,
  limit = 20,
  db?: DbDriver,
): Promise<(CampaignChangeRow & { campaign_name: string | null; customer_name: string | null })[]> {
  const driver = db ?? (await getDb());
  return driver.query<CampaignChangeRow & { campaign_name: string | null; customer_name: string | null }>(
    `SELECT cc.*, k.name AS campaign_name, c.contact_name AS customer_name
     FROM campaign_changes cc
     JOIN campaigns k ON k.id = cc.campaign_id
     JOIN customers c ON c.id = k.customer_id
     WHERE cc.created_at >= ?
     ORDER BY cc.created_at DESC LIMIT ?`,
    [sinceIso, limit],
  );
}

/* ------------------------------------------------------------------ reports */

export async function createReport(
  data: Partial<ReportRow> & { customer_id: string; report_type: ReportType; title: string; summary: string },
  db?: DbDriver,
): Promise<ReportRow> {
  const row: ReportRow = {
    id: data.id ?? crypto.randomUUID(),
    customer_id: data.customer_id,
    project_id: data.project_id ?? null,
    campaign_id: data.campaign_id ?? null,
    ad_plan_id: data.ad_plan_id ?? null,
    report_type: data.report_type,
    language: data.language ?? "ar",
    period_start: data.period_start ?? null,
    period_end: data.period_end ?? null,
    title: data.title,
    summary: data.summary,
    body: data.body ?? null,
    metrics: data.metrics ?? null,
    status: data.status ?? "DRAFT",
    channel: data.channel ?? "PORTAL",
    generated_by_agent: data.generated_by_agent ?? null,
    sent_at: data.sent_at ?? null,
    is_demo: data.is_demo ?? 0,
    created_at: nowIso(),
  };
  await insertRow("reports", row, db);
  return row;
}

export async function updateReport(
  id: string,
  data: Partial<ReportRow>,
  db?: DbDriver,
): Promise<ReportRow | undefined> {
  return updateRow<ReportRow>("reports", id, clean(data), db);
}

export async function findReportById(id: string, db?: DbDriver): Promise<ReportRow | undefined> {
  return findRowById<ReportRow>("reports", id, db);
}

export async function listReports(
  filter: {
    customerId?: string;
    campaignId?: string;
    adPlanId?: string;
    reportType?: ReportType;
    status?: ReportRow["status"];
    limit?: number;
    offset?: number;
  } = {},
  db?: DbDriver,
): Promise<{ rows: ReportRow[]; total: number }> {
  const driver = db ?? (await getDb());
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (filter.customerId) {
    clauses.push("customer_id = ?");
    params.push(filter.customerId);
  }
  if (filter.campaignId) {
    clauses.push("campaign_id = ?");
    params.push(filter.campaignId);
  }
  if (filter.adPlanId) {
    clauses.push("ad_plan_id = ?");
    params.push(filter.adPlanId);
  }
  if (filter.reportType) {
    clauses.push("report_type = ?");
    params.push(filter.reportType);
  }
  if (filter.status) {
    clauses.push("status = ?");
    params.push(filter.status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const totalRow = await driver.get<{ total: number }>(
    `SELECT COUNT(*) AS total FROM reports ${where}`,
    params,
  );
  const rows = await driver.query<ReportRow>(
    `SELECT * FROM reports ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, filter.limit ?? 30, filter.offset ?? 0],
  );
  return { rows, total: Number(totalRow?.total ?? 0) };
}

export async function findReportForDay(
  campaignId: string,
  dayKey: string,
  db?: DbDriver,
): Promise<ReportRow | undefined> {
  const driver = db ?? (await getDb());
  return driver.get<ReportRow>(
    `SELECT * FROM reports WHERE campaign_id = ? AND report_type = 'CAMPAIGN_DAILY' AND period_end = ? LIMIT 1`,
    [campaignId, dayKey],
  );
}

/** Campaign spend totals per customer, used by the dashboard revenue views. */
export async function campaignSpendByCustomer(
  sinceIso: string,
  db?: DbDriver,
): Promise<{ customer_id: string; currency: string; spent_minor: number }[]> {
  const driver = db ?? (await getDb());
  const rows = await driver.query<{ customer_id: string; currency: string; spent_minor: number | null }>(
    `SELECT k.customer_id, k.currency, SUM(m.cost_minor) AS spent_minor
     FROM campaign_metrics_daily m JOIN campaigns k ON k.id = m.campaign_id
     WHERE m.metric_date >= ? GROUP BY k.customer_id, k.currency`,
    [sinceIso.slice(0, 10)],
  );
  return rows.map((row) => ({
    customer_id: row.customer_id,
    currency: row.currency,
    spent_minor: Number(row.spent_minor ?? 0),
  }));
}
