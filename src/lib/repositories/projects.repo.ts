import { getDb } from "@/lib/db";
import type { DbDriver } from "@/lib/db/types";
import type {
  ProjectRow,
  ProjectServiceRow,
  ProjectStatus,
  ProjectTaskRow,
  ProjectWithCustomer,
  TaskStatus,
} from "@/lib/domain/types";
import { nowIso } from "@/lib/core/date";

import { clean, findRowById, insertRow, updateRow } from "./base";

export interface ProjectFilter {
  customerId?: string;
  status?: ProjectStatus[];
  search?: string;
  limit?: number;
  offset?: number;
  /** A project is late when it is still active past its due date. */
  overdueOnly?: boolean;
}

const CUSTOMER_JOIN = `
  SELECT p.*, c.contact_name AS customer_name, c.company_name AS customer_company,
         c.locale AS customer_locale
  FROM projects p
  JOIN customers c ON c.id = p.customer_id`;

export async function createProject(
  data: Partial<ProjectRow> & { customer_id: string; title: string; code: string },
  db?: DbDriver,
): Promise<ProjectRow> {
  const timestamp = nowIso();
  const row: ProjectRow = {
    id: data.id ?? crypto.randomUUID(),
    code: data.code,
    customer_id: data.customer_id,
    title: data.title,
    title_en: data.title_en ?? null,
    brief: data.brief ?? null,
    status: data.status ?? "DRAFT",
    currency: data.currency ?? "USD",
    amount_total_minor: data.amount_total_minor ?? 0,
    internal_cost_minor: data.internal_cost_minor ?? 0,
    margin_pct: data.margin_pct ?? null,
    country: data.country ?? null,
    progress: data.progress ?? 0,
    risk_level: data.risk_level ?? null,
    start_date: data.start_date ?? null,
    due_date: data.due_date ?? null,
    completed_at: data.completed_at ?? null,
    ai_plan: data.ai_plan ?? null,
    created_by_user_id: data.created_by_user_id ?? null,
    created_by_agent: data.created_by_agent ?? null,
    is_demo: data.is_demo ?? 0,
    created_at: timestamp,
    updated_at: timestamp,
  };
  await insertRow("projects", row, db);
  return row;
}

export async function updateProject(
  id: string,
  data: Partial<ProjectRow>,
  db?: DbDriver,
): Promise<ProjectRow | undefined> {
  return updateRow<ProjectRow>("projects", id, { ...clean(data), updated_at: nowIso() }, db);
}

export async function findProjectById(id: string, db?: DbDriver): Promise<ProjectWithCustomer | undefined> {
  const driver = db ?? (await getDb());
  return driver.get<ProjectWithCustomer>(`${CUSTOMER_JOIN} WHERE p.id = ?`, [id]);
}

export async function findProjectByCode(code: string, db?: DbDriver): Promise<ProjectRow | undefined> {
  const driver = db ?? (await getDb());
  return driver.get<ProjectRow>("SELECT * FROM projects WHERE code = ?", [code]);
}

export async function listProjects(
  filter: ProjectFilter = {},
  db?: DbDriver,
): Promise<{ rows: ProjectWithCustomer[]; total: number }> {
  const driver = db ?? (await getDb());
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (filter.customerId) {
    clauses.push("p.customer_id = ?");
    params.push(filter.customerId);
  }
  if (filter.status?.length) {
    clauses.push(`p.status IN (${filter.status.map(() => "?").join(", ")})`);
    params.push(...filter.status);
  }
  if (filter.search) {
    clauses.push("(p.title LIKE ? ESCAPE '\\' OR p.code LIKE ? ESCAPE '\\')");
    params.push(`%${filter.search}%`, `%${filter.search}%`);
  }
  if (filter.overdueOnly) {
    clauses.push(
      "p.due_date IS NOT NULL AND p.due_date < ? AND p.status NOT IN ('COMPLETED', 'CANCELLED')",
    );
    params.push(nowIso());
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const totalRow = await driver.get<{ total: number }>(
    `SELECT COUNT(*) AS total FROM projects p ${where}`,
    params,
  );
  const rows = await driver.query<ProjectWithCustomer>(
    `${CUSTOMER_JOIN} ${where} ORDER BY p.created_at DESC LIMIT ? OFFSET ?`,
    [...params, filter.limit ?? 50, filter.offset ?? 0],
  );
  return { rows, total: Number(totalRow?.total ?? 0) };
}

export async function listProjectCodes(db?: DbDriver): Promise<string[]> {
  const driver = db ?? (await getDb());
  const rows = await driver.query<{ code: string }>("SELECT code FROM projects");
  return rows.map((row) => row.code);
}

export async function countProjectsByStatus(db?: DbDriver): Promise<Record<string, number>> {
  const driver = db ?? (await getDb());
  const rows = await driver.query<{ status: string; total: number }>(
    "SELECT status, COUNT(*) AS total FROM projects GROUP BY status",
  );
  return Object.fromEntries(rows.map((row) => [row.status, Number(row.total)]));
}

export async function listOverdueProjects(limit = 10, db?: DbDriver): Promise<ProjectWithCustomer[]> {
  const driver = db ?? (await getDb());
  return driver.query<ProjectWithCustomer>(
    `${CUSTOMER_JOIN} WHERE p.due_date IS NOT NULL AND p.due_date < ? AND p.status NOT IN ('COMPLETED', 'CANCELLED')
     ORDER BY p.due_date ASC LIMIT ?`,
    [nowIso(), limit],
  );
}

/* -------------------------------------------------------- project services --- */

export async function addProjectService(
  data: Partial<ProjectServiceRow> & { project_id: string; name_snapshot: string },
  db?: DbDriver,
): Promise<ProjectServiceRow> {
  const row: ProjectServiceRow = {
    id: data.id ?? crypto.randomUUID(),
    project_id: data.project_id,
    service_id: data.service_id ?? null,
    name_snapshot: data.name_snapshot,
    quantity: data.quantity ?? 1,
    unit_price_minor: data.unit_price_minor ?? 0,
    billing_type: data.billing_type ?? "ONE_TIME",
    months: data.months ?? null,
    notes: data.notes ?? null,
    created_at: nowIso(),
  };
  await insertRow("project_services", row, db);
  return row;
}

export async function listProjectServices(projectId: string, db?: DbDriver): Promise<ProjectServiceRow[]> {
  const driver = db ?? (await getDb());
  return driver.query<ProjectServiceRow>(
    "SELECT * FROM project_services WHERE project_id = ? ORDER BY created_at",
    [projectId],
  );
}

/* ------------------------------------------------------------ project tasks -- */

export async function createProjectTask(
  data: Partial<ProjectTaskRow> & { project_id: string; title: string },
  db?: DbDriver,
): Promise<ProjectTaskRow> {
  const timestamp = nowIso();
  const row: ProjectTaskRow = {
    id: data.id ?? crypto.randomUUID(),
    project_id: data.project_id,
    title: data.title,
    title_en: data.title_en ?? null,
    description: data.description ?? null,
    status: data.status ?? "TODO",
    visibility: data.visibility ?? "CLIENT",
    sort_order: data.sort_order ?? 0,
    due_date: data.due_date ?? null,
    completed_at: data.completed_at ?? null,
    assigned_agent: data.assigned_agent ?? null,
    created_at: timestamp,
    updated_at: timestamp,
  };
  await insertRow("project_tasks", row, db);
  return row;
}

export async function updateProjectTask(
  id: string,
  data: Partial<ProjectTaskRow>,
  db?: DbDriver,
): Promise<ProjectTaskRow | undefined> {
  return updateRow<ProjectTaskRow>("project_tasks", id, { ...clean(data), updated_at: nowIso() }, db);
}

export async function findProjectTask(id: string, db?: DbDriver): Promise<ProjectTaskRow | undefined> {
  return findRowById<ProjectTaskRow>("project_tasks", id, db);
}

export async function listProjectTasks(
  projectId: string,
  options: { includeInternal?: boolean } = {},
  db?: DbDriver,
): Promise<ProjectTaskRow[]> {
  const driver = db ?? (await getDb());
  const where = options.includeInternal ? "" : "AND visibility = 'CLIENT'";
  return driver.query<ProjectTaskRow>(
    `SELECT * FROM project_tasks WHERE project_id = ? ${where} ORDER BY sort_order, created_at`,
    [projectId],
  );
}

export async function deleteProjectTask(id: string, db?: DbDriver): Promise<void> {
  const driver = db ?? (await getDb());
  await driver.run("DELETE FROM project_tasks WHERE id = ?", [id]);
}

/** Recomputes project progress from CLIENT-visible task completion. */
export async function recomputeProgress(projectId: string, db?: DbDriver): Promise<number> {
  const driver = db ?? (await getDb());
  const row = await driver.get<{ total: number; done: number }>(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status = 'DONE' THEN 1 ELSE 0 END) AS done
     FROM project_tasks WHERE project_id = ? AND visibility = 'CLIENT'`,
    [projectId],
  );
  const total = Number(row?.total ?? 0);
  const done = Number(row?.done ?? 0);
  const progress = total === 0 ? 0 : Math.round((done / total) * 100);
  await driver.run("UPDATE projects SET progress = ?, updated_at = ? WHERE id = ?", [
    progress,
    nowIso(),
    projectId,
  ]);
  return progress;
}

export async function countTasksByStatus(db?: DbDriver): Promise<Record<TaskStatus, number>> {
  const driver = db ?? (await getDb());
  const rows = await driver.query<{ status: TaskStatus; total: number }>(
    "SELECT status, COUNT(*) AS total FROM project_tasks GROUP BY status",
  );
  const output: Record<string, number> = { TODO: 0, IN_PROGRESS: 0, BLOCKED: 0, REVIEW: 0, DONE: 0 };
  for (const row of rows) output[row.status] = Number(row.total);
  return output as Record<TaskStatus, number>;
}
