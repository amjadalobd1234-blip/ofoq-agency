import { getDb } from "@/lib/db";
import type { DbDriver } from "@/lib/db/types";
import type {
  AdPlanResultRow,
  AdPlanRow,
  AdPlanStatus,
  AdPlanWithCustomer,
  AdResultPlatform,
} from "@/lib/domain/types";
import { nowIso } from "@/lib/core/date";

import { clean, findRowById, insertRow, updateRow } from "./base";

export function adPlanFamilyKey(customerId: string, projectId?: string | null): string {
  return projectId ? `${customerId}:${projectId}` : customerId;
}

export async function createAdPlan(
  data: Partial<AdPlanRow> & { customer_id: string; code: string; family_key: string },
  db?: DbDriver,
): Promise<AdPlanRow> {
  const timestamp = nowIso();
  const row: AdPlanRow = {
    id: data.id ?? crypto.randomUUID(),
    code: data.code,
    customer_id: data.customer_id,
    project_id: data.project_id ?? null,
    family_key: data.family_key,
    version: data.version ?? 1,
    status: data.status ?? "DRAFT",
    locale: data.locale ?? "ar",
    currency: data.currency ?? "USD",
    summary: data.summary ?? null,
    body: data.body ?? "{}",
    forecasts: data.forecasts ?? null,
    internal_note: data.internal_note ?? null,
    review_note: data.review_note ?? null,
    created_by_user_id: data.created_by_user_id ?? null,
    created_by_agent: data.created_by_agent ?? null,
    approved_by_user_id: data.approved_by_user_id ?? null,
    approved_at: data.approved_at ?? null,
    created_at: timestamp,
    updated_at: timestamp,
  };
  await insertRow("ad_plans", row, db);
  return row;
}

export async function updateAdPlan(
  id: string,
  data: Partial<AdPlanRow>,
  db?: DbDriver,
): Promise<AdPlanRow | undefined> {
  return updateRow<AdPlanRow>("ad_plans", id, { ...clean(data), updated_at: nowIso() }, db);
}

export async function findAdPlanById(id: string, db?: DbDriver): Promise<AdPlanRow | undefined> {
  return findRowById<AdPlanRow>("ad_plans", id, db);
}

export async function listAdPlanCodes(db?: DbDriver): Promise<string[]> {
  const driver = db ?? (await getDb());
  const rows = await driver.query<{ code: string }>("SELECT code FROM ad_plans");
  return rows.map((row) => row.code);
}

export async function nextAdPlanVersion(familyKey: string, db?: DbDriver): Promise<number> {
  const driver = db ?? (await getDb());
  const row = await driver.get<{ max_version: number | null }>(
    "SELECT MAX(version) AS max_version FROM ad_plans WHERE family_key = ?",
    [familyKey],
  );
  return Number(row?.max_version ?? 0) + 1;
}

export async function findLatestAdPlan(
  familyKey: string,
  db?: DbDriver,
): Promise<AdPlanRow | undefined> {
  const driver = db ?? (await getDb());
  return driver.get<AdPlanRow>(
    "SELECT * FROM ad_plans WHERE family_key = ? ORDER BY version DESC LIMIT 1",
    [familyKey],
  );
}

export async function findLatestApprovedAdPlan(
  familyKey: string,
  db?: DbDriver,
): Promise<AdPlanRow | undefined> {
  const driver = db ?? (await getDb());
  return driver.get<AdPlanRow>(
    "SELECT * FROM ad_plans WHERE family_key = ? AND status = 'APPROVED' ORDER BY version DESC LIMIT 1",
    [familyKey],
  );
}

export async function listAdPlansForFamily(familyKey: string, db?: DbDriver): Promise<AdPlanRow[]> {
  const driver = db ?? (await getDb());
  return driver.query<AdPlanRow>(
    "SELECT * FROM ad_plans WHERE family_key = ? ORDER BY version DESC",
    [familyKey],
  );
}

export async function listAdPlans(
  filter: {
    customerId?: string;
    projectId?: string | null;
    status?: AdPlanStatus[];
    limit?: number;
    offset?: number;
  } = {},
  db?: DbDriver,
): Promise<{ rows: AdPlanWithCustomer[]; total: number }> {
  const driver = db ?? (await getDb());
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (filter.customerId) {
    clauses.push("p.customer_id = ?");
    params.push(filter.customerId);
  }
  if (filter.projectId) {
    clauses.push("p.project_id = ?");
    params.push(filter.projectId);
  }
  if (filter.status?.length) {
    clauses.push(`p.status IN (${filter.status.map(() => "?").join(", ")})`);
    params.push(...filter.status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const totalRow = await driver.get<{ total: number }>(
    `SELECT COUNT(*) AS total FROM ad_plans p ${where}`,
    params,
  );
  const rows = await driver.query<AdPlanWithCustomer>(
    `SELECT p.*, c.contact_name AS customer_name, c.company_name AS customer_company
     FROM ad_plans p JOIN customers c ON c.id = p.customer_id
     ${where} ORDER BY p.created_at DESC LIMIT ? OFFSET ?`,
    [...params, filter.limit ?? 50, filter.offset ?? 0],
  );
  return { rows, total: Number(totalRow?.total ?? 0) };
}

/** Latest version of each family, for the staff list. */
export async function listLatestAdPlans(
  filter: { customerId?: string; limit?: number } = {},
  db?: DbDriver,
): Promise<AdPlanWithCustomer[]> {
  const driver = db ?? (await getDb());
  const clauses = ["p.version = (SELECT MAX(p2.version) FROM ad_plans p2 WHERE p2.family_key = p.family_key)"];
  const params: (string | number)[] = [];
  if (filter.customerId) {
    clauses.push("p.customer_id = ?");
    params.push(filter.customerId);
  }
  return driver.query<AdPlanWithCustomer>(
    `SELECT p.*, c.contact_name AS customer_name, c.company_name AS customer_company
     FROM ad_plans p JOIN customers c ON c.id = p.customer_id
     WHERE ${clauses.join(" AND ")}
     ORDER BY p.updated_at DESC LIMIT ?`,
    [...params, filter.limit ?? 50],
  );
}

/** Latest APPROVED version of each family — the only rows a client may see. */
export async function listApprovedAdPlansForCustomer(
  customerId: string,
  db?: DbDriver,
): Promise<AdPlanWithCustomer[]> {
  const driver = db ?? (await getDb());
  return driver.query<AdPlanWithCustomer>(
    `SELECT p.*, c.contact_name AS customer_name, c.company_name AS customer_company
     FROM ad_plans p JOIN customers c ON c.id = p.customer_id
     WHERE p.customer_id = ? AND p.status = 'APPROVED'
       AND p.version = (
         SELECT MAX(p2.version) FROM ad_plans p2
         WHERE p2.family_key = p.family_key AND p2.status = 'APPROVED'
       )
     ORDER BY p.approved_at DESC`,
    [customerId],
  );
}

export async function createAdPlanResult(
  data: Partial<AdPlanResultRow> & { ad_plan_id: string; customer_id: string; result_date: string },
  db?: DbDriver,
): Promise<AdPlanResultRow> {
  const row: AdPlanResultRow = {
    id: data.id ?? crypto.randomUUID(),
    ad_plan_id: data.ad_plan_id,
    customer_id: data.customer_id,
    result_date: data.result_date,
    platform: data.platform ?? "ALL",
    spend_minor: data.spend_minor ?? 0,
    impressions: data.impressions ?? 0,
    clicks: data.clicks ?? 0,
    messages: data.messages ?? 0,
    orders: data.orders ?? 0,
    source: "MANUAL",
    notes: data.notes ?? null,
    created_by_user_id: data.created_by_user_id ?? null,
    created_at: nowIso(),
  };
  await insertRow("ad_plan_results", row, db);
  return row;
}

export async function upsertAdPlanResult(
  data: {
    ad_plan_id: string;
    customer_id: string;
    result_date: string;
    platform?: AdResultPlatform;
    spend_minor?: number;
    impressions?: number;
    clicks?: number;
    messages?: number;
    orders?: number;
    notes?: string | null;
    created_by_user_id?: string | null;
  },
  db?: DbDriver,
): Promise<AdPlanResultRow> {
  const driver = db ?? (await getDb());
  const platform = data.platform ?? "ALL";
  const existing = await driver.get<AdPlanResultRow>(
    "SELECT * FROM ad_plan_results WHERE ad_plan_id = ? AND result_date = ? AND platform = ?",
    [data.ad_plan_id, data.result_date, platform],
  );
  if (existing) {
    await driver.run(
      `UPDATE ad_plan_results
       SET spend_minor = ?, impressions = ?, clicks = ?, messages = ?, orders = ?, notes = ?
       WHERE id = ?`,
      [
        data.spend_minor ?? existing.spend_minor,
        data.impressions ?? existing.impressions,
        data.clicks ?? existing.clicks,
        data.messages ?? existing.messages,
        data.orders ?? existing.orders,
        data.notes === undefined ? existing.notes : data.notes,
        existing.id,
      ],
    );
    return (await findRowById<AdPlanResultRow>("ad_plan_results", existing.id, driver))!;
  }
  return createAdPlanResult({ ...data, platform, source: "MANUAL" }, driver);
}

export async function listAdPlanResults(
  adPlanId: string,
  db?: DbDriver,
): Promise<AdPlanResultRow[]> {
  const driver = db ?? (await getDb());
  return driver.query<AdPlanResultRow>(
    "SELECT * FROM ad_plan_results WHERE ad_plan_id = ? ORDER BY result_date ASC, created_at ASC",
    [adPlanId],
  );
}

export async function listAdPlanResultsForFamily(
  familyKey: string,
  db?: DbDriver,
): Promise<AdPlanResultRow[]> {
  const driver = db ?? (await getDb());
  return driver.query<AdPlanResultRow>(
    `SELECT r.* FROM ad_plan_results r
     JOIN ad_plans p ON p.id = r.ad_plan_id
     WHERE p.family_key = ?
     ORDER BY r.result_date ASC, r.created_at ASC`,
    [familyKey],
  );
}
