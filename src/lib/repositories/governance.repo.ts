import { getDb } from "@/lib/db";
import type { DbDriver } from "@/lib/db/types";
import type {
  ActivityRow,
  AlertRow,
  AlertSeverity,
  AlertStatus,
  FileRow,
  IntegrationConnectionRow,
  IntegrationStatus,
  JobRunRow,
  ReviewRow,
  ReviewStatus,
  SettingRow,
} from "@/lib/domain/types";
import { nowIso } from "@/lib/core/date";

import { clean, findRowById, insertRow, parseJson, updateRow } from "./base";

/* --------------------------------------------------------------- activities */

export async function recordActivity(
  data: {
    actor_type: ActivityRow["actor_type"];
    action: string;
    actor_user_id?: string | null;
    actor_label?: string | null;
    entity_type?: string | null;
    entity_id?: string | null;
    customer_id?: string | null;
    summary?: string | null;
    meta?: unknown;
    ip?: string | null;
    user_agent?: string | null;
    is_demo?: number;
  },
  db?: DbDriver,
): Promise<ActivityRow> {
  const row: ActivityRow = {
    id: crypto.randomUUID(),
    actor_type: data.actor_type,
    actor_user_id: data.actor_user_id ?? null,
    actor_label: data.actor_label ?? null,
    action: data.action,
    entity_type: data.entity_type ?? null,
    entity_id: data.entity_id ?? null,
    customer_id: data.customer_id ?? null,
    summary: data.summary ?? null,
    meta: data.meta === undefined ? null : JSON.stringify(data.meta),
    ip: data.ip ?? null,
    user_agent: data.user_agent ?? null,
    is_demo: data.is_demo ?? 0,
    created_at: nowIso(),
  };
  await insertRow("activities", row, db);
  return row;
}

export interface ActivityFilter {
  customerId?: string;
  entityType?: string;
  entityId?: string;
  actorType?: ActivityRow["actor_type"];
  action?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export async function listActivities(
  filter: ActivityFilter = {},
  db?: DbDriver,
): Promise<{ rows: ActivityRow[]; total: number }> {
  const driver = db ?? (await getDb());
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (filter.customerId) {
    clauses.push("customer_id = ?");
    params.push(filter.customerId);
  }
  if (filter.entityType) {
    clauses.push("entity_type = ?");
    params.push(filter.entityType);
  }
  if (filter.entityId) {
    clauses.push("entity_id = ?");
    params.push(filter.entityId);
  }
  if (filter.actorType) {
    clauses.push("actor_type = ?");
    params.push(filter.actorType);
  }
  if (filter.action) {
    clauses.push("action = ?");
    params.push(filter.action);
  }
  if (filter.search) {
    clauses.push("(summary LIKE ? OR action LIKE ?)");
    params.push(`%${filter.search}%`, `%${filter.search}%`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const totalRow = await driver.get<{ total: number }>(
    `SELECT COUNT(*) AS total FROM activities ${where}`,
    params,
  );
  const rows = await driver.query<ActivityRow>(
    `SELECT * FROM activities ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, filter.limit ?? 30, filter.offset ?? 0],
  );
  return { rows, total: Number(totalRow?.total ?? 0) };
}

/* ----------------------------------------------------------------- settings */

export async function getSetting(key: string, db?: DbDriver): Promise<SettingRow | undefined> {
  const driver = db ?? (await getDb());
  return driver.get<SettingRow>("SELECT * FROM settings WHERE key = ?", [key]);
}

export async function getSettingValue<T>(key: string, fallback: T, db?: DbDriver): Promise<T> {
  const row = await getSetting(key, db);
  if (!row) return fallback;
  switch (row.value_type) {
    case "number":
      return Number(row.value) as unknown as T;
    case "boolean":
      return (row.value === "true" || row.value === "1") as unknown as T;
    case "json":
      return parseJson<T>(row.value, fallback);
    default:
      return row.value as unknown as T;
  }
}

export async function setSetting(
  key: string,
  value: unknown,
  options: { type?: SettingRow["value_type"]; updatedBy?: string | null } = {},
  db?: DbDriver,
): Promise<void> {
  const driver = db ?? (await getDb());
  const explicitType = options.type;
  const isEmptyObject = typeof value === "object" && value !== null;
  const type: SettingRow["value_type"] =
    explicitType ?? (isEmptyObject ? "json" : typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : "string");
  const serialised = type === "json" ? JSON.stringify(value ?? null) : String(value);

  const existing = await getSetting(key, driver);
  if (existing) {
    await driver.run("UPDATE settings SET value = ?, value_type = ?, updated_by_user_id = ?, updated_at = ? WHERE key = ?", [
      serialised,
      type,
      options.updatedBy ?? null,
      nowIso(),
      key,
    ]);
    return;
  }
  await insertRow(
    "settings",
    {
      key,
      value: serialised,
      value_type: type,
      updated_by_user_id: options.updatedBy ?? null,
      updated_at: nowIso(),
    },
    driver,
  );
}

export async function listSettings(db?: DbDriver): Promise<SettingRow[]> {
  const driver = db ?? (await getDb());
  return driver.query<SettingRow>("SELECT * FROM settings ORDER BY key");
}

/* ------------------------------------------------------------------- alerts */

/**
 * Creates an alert unless an unresolved alert with the same `dedupeKey` exists,
 * which keeps repeated job runs from flooding the dashboard.
 */
export async function raiseAlert(
  data: {
    severity: AlertSeverity;
    category: string;
    title_ar: string;
    title_en: string;
    body_ar?: string | null;
    body_en?: string | null;
    entity_type?: string | null;
    entity_id?: string | null;
    customer_id?: string | null;
    target_role?: AlertRow["target_role"];
    dedupe_key?: string | null;
    meta?: unknown;
    is_demo?: number;
  },
  db?: DbDriver,
): Promise<{ alert: AlertRow; created: boolean }> {
  const driver = db ?? (await getDb());
  if (data.dedupe_key) {
    const existing = await driver.get<AlertRow>(
      "SELECT * FROM alerts WHERE dedupe_key = ? AND status <> 'RESOLVED'",
      [data.dedupe_key],
    );
    if (existing) return { alert: existing, created: false };
  }
  const timestamp = nowIso();
  const row: AlertRow = {
    id: crypto.randomUUID(),
    severity: data.severity,
    category: data.category,
    title_ar: data.title_ar,
    title_en: data.title_en,
    body_ar: data.body_ar ?? null,
    body_en: data.body_en ?? null,
    entity_type: data.entity_type ?? null,
    entity_id: data.entity_id ?? null,
    customer_id: data.customer_id ?? null,
    target_role: data.target_role ?? "ANY_STAFF",
    status: "NEW",
    acknowledged_by_user_id: null,
    acknowledged_at: null,
    resolved_at: null,
    dedupe_key: data.dedupe_key ?? null,
    meta: data.meta === undefined ? null : JSON.stringify(data.meta),
    is_demo: data.is_demo ?? 0,
    created_at: timestamp,
    updated_at: timestamp,
  };
  await insertRow("alerts", row, driver);
  return { alert: row, created: true };
}

export async function updateAlert(
  id: string,
  data: Partial<AlertRow>,
  db?: DbDriver,
): Promise<AlertRow | undefined> {
  return updateRow<AlertRow>("alerts", id, { ...clean(data), updated_at: nowIso() }, db);
}

export async function findAlertById(id: string, db?: DbDriver): Promise<AlertRow | undefined> {
  return findRowById<AlertRow>("alerts", id, db);
}

export async function listAlerts(
  filter: {
    status?: AlertStatus[];
    severity?: AlertSeverity[];
    category?: string;
    customerId?: string;
    limit?: number;
    offset?: number;
  } = {},
  db?: DbDriver,
): Promise<{ rows: AlertRow[]; total: number }> {
  const driver = db ?? (await getDb());
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (filter.status?.length) {
    clauses.push(`status IN (${filter.status.map(() => "?").join(", ")})`);
    params.push(...filter.status);
  }
  if (filter.severity?.length) {
    clauses.push(`severity IN (${filter.severity.map(() => "?").join(", ")})`);
    params.push(...filter.severity);
  }
  if (filter.category) {
    clauses.push("category = ?");
    params.push(filter.category);
  }
  if (filter.customerId) {
    clauses.push("customer_id = ?");
    params.push(filter.customerId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const totalRow = await driver.get<{ total: number }>(
    `SELECT COUNT(*) AS total FROM alerts ${where}`,
    params,
  );
  const rows = await driver.query<AlertRow>(
    `SELECT * FROM alerts ${where}
     ORDER BY CASE severity WHEN 'URGENT' THEN 0 WHEN 'IMPORTANT' THEN 1 ELSE 2 END, created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, filter.limit ?? 50, filter.offset ?? 0],
  );
  return { rows, total: Number(totalRow?.total ?? 0) };
}

export async function countAlertsBySeverity(db?: DbDriver): Promise<Record<AlertSeverity, number>> {
  const driver = db ?? (await getDb());
  const rows = await driver.query<{ severity: AlertSeverity; total: number }>(
    "SELECT severity, COUNT(*) AS total FROM alerts WHERE status <> 'RESOLVED' GROUP BY severity",
  );
  const output: Record<string, number> = { URGENT: 0, IMPORTANT: 0, INFO: 0 };
  for (const row of rows) output[row.severity] = Number(row.total);
  return output as Record<AlertSeverity, number>;
}

/* -------------------------------------------------------------------- files */

export async function createFile(
  data: Partial<FileRow> & { customer_id: string; name: string; storage_key: string },
  db?: DbDriver,
): Promise<FileRow> {
  const row: FileRow = {
    id: data.id ?? crypto.randomUUID(),
    customer_id: data.customer_id,
    project_id: data.project_id ?? null,
    offer_id: data.offer_id ?? null,
    uploader_type: data.uploader_type ?? "CLIENT",
    uploader_user_id: data.uploader_user_id ?? null,
    name: data.name,
    kind: data.kind ?? null,
    mime: data.mime ?? null,
    size_bytes: data.size_bytes ?? 0,
    storage_provider: data.storage_provider ?? "local",
    storage_key: data.storage_key,
    visibility: data.visibility ?? "CLIENT",
    checksum: data.checksum ?? null,
    is_demo: data.is_demo ?? 0,
    created_at: nowIso(),
  };
  await insertRow("files", row, db);
  return row;
}

export async function findFileById(id: string, db?: DbDriver): Promise<FileRow | undefined> {
  return findRowById<FileRow>("files", id, db);
}

export async function listFiles(
  filter: { customerId?: string; projectId?: string; visibility?: FileRow["visibility"]; limit?: number } = {},
  db?: DbDriver,
): Promise<FileRow[]> {
  const driver = db ?? (await getDb());
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (filter.customerId) {
    clauses.push("customer_id = ?");
    params.push(filter.customerId);
  }
  if (filter.projectId) {
    clauses.push("project_id = ?");
    params.push(filter.projectId);
  }
  if (filter.visibility) {
    clauses.push("visibility = ?");
    params.push(filter.visibility);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return driver.query<FileRow>(
    `SELECT * FROM files ${where} ORDER BY created_at DESC LIMIT ?`,
    [...params, filter.limit ?? 100],
  );
}

export async function deleteFile(id: string, db?: DbDriver): Promise<void> {
  const driver = db ?? (await getDb());
  await driver.run("DELETE FROM files WHERE id = ?", [id]);
}

/* ------------------------------------------------------------------ reviews */

export async function createReview(
  data: Partial<ReviewRow> & { customer_id: string; rating: number },
  db?: DbDriver,
): Promise<ReviewRow> {
  const timestamp = nowIso();
  const row: ReviewRow = {
    id: data.id ?? crypto.randomUUID(),
    customer_id: data.customer_id,
    project_id: data.project_id ?? null,
    rating: data.rating,
    satisfaction: data.satisfaction ?? null,
    liked: data.liked ?? null,
    improve: data.improve ?? null,
    wants_more: data.wants_more ?? 0,
    note: data.note ?? null,
    status: data.status ?? "PENDING",
    published: data.published ?? 0,
    published_name: data.published_name ?? null,
    published_at: data.published_at ?? null,
    source: data.source ?? "PORTAL",
    is_demo: data.is_demo ?? 0,
    created_at: timestamp,
    updated_at: timestamp,
  };
  await insertRow("reviews", row, db);
  return row;
}

export async function updateReview(
  id: string,
  data: Partial<ReviewRow>,
  db?: DbDriver,
): Promise<ReviewRow | undefined> {
  return updateRow<ReviewRow>("reviews", id, { ...clean(data), updated_at: nowIso() }, db);
}

export async function listReviews(
  filter: { customerId?: string; status?: ReviewStatus[]; publishedOnly?: boolean; limit?: number } = {},
  db?: DbDriver,
): Promise<ReviewRow[]> {
  const driver = db ?? (await getDb());
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (filter.customerId) {
    clauses.push("customer_id = ?");
    params.push(filter.customerId);
  }
  if (filter.status?.length) {
    clauses.push(`status IN (${filter.status.map(() => "?").join(", ")})`);
    params.push(...filter.status);
  }
  if (filter.publishedOnly) clauses.push("published = 1");

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return driver.query<ReviewRow>(
    `SELECT * FROM reviews ${where} ORDER BY created_at DESC LIMIT ?`,
    [...params, filter.limit ?? 50],
  );
}

export async function reviewStats(db?: DbDriver): Promise<{ average: number | null; count: number }> {
  const driver = db ?? (await getDb());
  const row = await driver.get<{ average: number | null; total: number }>(
    "SELECT AVG(rating) AS average, COUNT(*) AS total FROM reviews WHERE status <> 'REJECTED'",
  );
  return {
    average: row?.average === null || row?.average === undefined ? null : Number(Number(row.average).toFixed(2)),
    count: Number(row?.total ?? 0),
  };
}

/* ------------------------------------------------------------- integrations */

export async function upsertIntegration(
  provider: string,
  data: Partial<IntegrationConnectionRow>,
  db?: DbDriver,
): Promise<IntegrationConnectionRow> {
  const driver = db ?? (await getDb());
  const existing = await getIntegration(provider, driver);
  const timestamp = nowIso();
  if (existing) {
    return (await updateRow<IntegrationConnectionRow>(
      "integration_connections",
      existing.id,
      { ...clean(data), updated_at: timestamp },
      driver,
    ))!;
  }
  const row: IntegrationConnectionRow = {
    id: crypto.randomUUID(),
    provider,
    status: (data.status ?? "DISABLED") as IntegrationStatus,
    account_label: data.account_label ?? null,
    account_ref: data.account_ref ?? null,
    scopes: data.scopes ?? null,
    access_token_enc: data.access_token_enc ?? null,
    refresh_token_enc: data.refresh_token_enc ?? null,
    token_expires_at: data.token_expires_at ?? null,
    last_error: data.last_error ?? null,
    meta: data.meta ?? null,
    last_checked_at: data.last_checked_at ?? null,
    created_at: timestamp,
    updated_at: timestamp,
  };
  await insertRow("integration_connections", row, driver);
  return row;
}

export async function getIntegration(
  provider: string,
  db?: DbDriver,
): Promise<IntegrationConnectionRow | undefined> {
  const driver = db ?? (await getDb());
  return driver.get<IntegrationConnectionRow>(
    "SELECT * FROM integration_connections WHERE provider = ?",
    [provider],
  );
}

export async function listIntegrations(db?: DbDriver): Promise<IntegrationConnectionRow[]> {
  const driver = db ?? (await getDb());
  return driver.query<IntegrationConnectionRow>(
    "SELECT * FROM integration_connections ORDER BY provider",
  );
}

export async function disableIntegration(provider: string, reason: string, db?: DbDriver): Promise<void> {
  const driver = db ?? (await getDb());
  const existing = await getIntegration(provider, driver);
  if (!existing) return;
  await driver.run(
    "UPDATE integration_connections SET status = 'DISABLED', access_token_enc = NULL, refresh_token_enc = NULL, last_error = ?, updated_at = ? WHERE provider = ?",
    [reason, nowIso(), provider],
  );
}

/* ---------------------------------------------------- webhooks and job runs */

export async function recordWebhookEvent(
  data: {
    provider: string;
    event_type?: string | null;
    external_id?: string | null;
    signature_valid: boolean;
    payload?: unknown;
  },
  db?: DbDriver,
): Promise<string> {
  const id = crypto.randomUUID();
  await insertRow(
    "webhook_events",
    {
      id,
      provider: data.provider,
      event_type: data.event_type ?? null,
      external_id: data.external_id ?? null,
      signature_valid: data.signature_valid ? 1 : 0,
      payload: data.payload === undefined ? null : JSON.stringify(data.payload),
      status: "RECEIVED",
      created_at: nowIso(),
    },
    db,
  );
  return id;
}

export async function markWebhookProcessed(
  id: string,
  status: "PROCESSED" | "IGNORED" | "FAILED",
  error?: string,
  db?: DbDriver,
): Promise<void> {
  const driver = db ?? (await getDb());
  await driver.run(
    "UPDATE webhook_events SET status = ?, error = ?, processed_at = ? WHERE id = ?",
    [status, error ?? null, nowIso(), id],
  );
}

export async function startJobRun(
  jobKey: string,
  meta?: unknown,
  db?: DbDriver,
): Promise<string> {
  const id = crypto.randomUUID();
  await insertRow(
    "job_runs",
    {
      id,
      job_key: jobKey,
      status: "RUNNING",
      started_at: nowIso(),
      items_processed: 0,
      meta: meta === undefined ? null : JSON.stringify(meta),
    },
    db,
  );
  return id;
}

export async function finishJobRun(
  id: string,
  data: { status: "SUCCEEDED" | "FAILED"; itemsProcessed: number; summary?: string; error?: string },
  db?: DbDriver,
): Promise<void> {
  const driver = db ?? (await getDb());
  await driver.run(
    "UPDATE job_runs SET status = ?, finished_at = ?, items_processed = ?, summary = ?, error = ? WHERE id = ?",
    [data.status, nowIso(), data.itemsProcessed, data.summary ?? null, data.error ?? null, id],
  );
}

export async function listRecentJobRuns(limit = 20, db?: DbDriver): Promise<JobRunRow[]> {
  const driver = db ?? (await getDb());
  return driver.query<JobRunRow>("SELECT * FROM job_runs ORDER BY started_at DESC LIMIT ?", [limit]);
}

export async function findJobRunByKeyToday(
  jobKey: string,
  dayKey: string,
  db?: DbDriver,
): Promise<JobRunRow | undefined> {
  const driver = db ?? (await getDb());
  return driver.get<JobRunRow>(
    `SELECT * FROM job_runs WHERE job_key = ? AND status = 'SUCCEEDED' AND started_at LIKE ? ORDER BY started_at DESC LIMIT 1`,
    [jobKey, `${dayKey}%`],
  );
}
