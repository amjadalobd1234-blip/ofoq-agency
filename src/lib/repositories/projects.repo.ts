import { getDb } from "@/lib/db";
import type { DbDriver } from "@/lib/db/types";
import type {
  ProjectPlanRow,
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
    internal_note: data.internal_note ?? null,
    phase_key: data.phase_key ?? null,
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

/**
 * The rule of a task the client is allowed to see.
 *
 * A task that belongs to a plan (`phase_key` is set) only becomes visible once
 * the owner has approved a plan for that project: a draft plan is a proposal,
 * never a commitment. A task that belongs to no plan (added by hand, or
 * created by an older flow) stays visible exactly as before.
 */
const CLIENT_VISIBLE_TASK_SQL = `
  visibility = 'CLIENT'
  AND (
    phase_key IS NULL
    OR EXISTS (
      SELECT 1 FROM project_plans AS approved_plan
      WHERE approved_plan.project_id = project_tasks.project_id
        AND approved_plan.status = 'APPROVED'
    )
  )`;

/** The tasks the client may see: committed work only, never a draft plan. */
export async function listClientVisibleTasks(
  projectId: string,
  db?: DbDriver,
): Promise<ProjectTaskRow[]> {
  const driver = db ?? (await getDb());
  return driver.query<ProjectTaskRow>(
    `SELECT * FROM project_tasks WHERE project_id = ? AND ${CLIENT_VISIBLE_TASK_SQL}
     ORDER BY sort_order, created_at`,
    [projectId],
  );
}

export async function deleteProjectTask(id: string, db?: DbDriver): Promise<void> {
  const driver = db ?? (await getDb());
  await driver.run("DELETE FROM project_tasks WHERE id = ?", [id]);
}

/** The tasks of several projects at once (used by the dashboards). */
export async function listTasksForProjects(
  projectIds: string[],
  options: { includeInternal?: boolean; committedOnly?: boolean } = {},
  db?: DbDriver,
): Promise<ProjectTaskRow[]> {
  if (projectIds.length === 0) return [];
  const driver = db ?? (await getDb());
  const placeholders = projectIds.map(() => "?").join(", ");
  const where = options.includeInternal
    ? ""
    : options.committedOnly
      ? `AND ${CLIENT_VISIBLE_TASK_SQL}`
      : "AND visibility = 'CLIENT'";
  return driver.query<ProjectTaskRow>(
    `SELECT * FROM project_tasks WHERE project_id IN (${placeholders}) ${where} ORDER BY sort_order, created_at`,
    projectIds,
  );
}

/** Recomputes project progress from the CLIENT-visible task completion. */
export async function recomputeProgress(projectId: string, db?: DbDriver): Promise<number> {
  const driver = db ?? (await getDb());
  const row = await driver.get<{ total: number; done: number }>(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status = 'DONE' THEN 1 ELSE 0 END) AS done
     FROM project_tasks WHERE project_id = ? AND ${CLIENT_VISIBLE_TASK_SQL}`,
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

/** Open tasks whose deadline has passed — the raw material of the delay alerts. */
export async function listOverdueTasks(
  options: { limit?: number; projectId?: string } = {},
  db?: DbDriver,
): Promise<(ProjectTaskRow & { project_code: string; customer_id: string })[]> {
  const driver = db ?? (await getDb());
  const clauses = ["t.status <> 'DONE'", "t.due_date IS NOT NULL", "t.due_date < ?"];
  const params: (string | number)[] = [nowIso()];
  if (options.projectId) {
    clauses.push("t.project_id = ?");
    params.push(options.projectId);
  }
  return driver.query<ProjectTaskRow & { project_code: string; customer_id: string }>(
    `SELECT t.*, p.code AS project_code, p.customer_id AS customer_id
     FROM project_tasks t JOIN projects p ON p.id = t.project_id
     WHERE ${clauses.join(" AND ")}
     ORDER BY t.due_date ASC LIMIT ?`,
    [...params, options.limit ?? 50],
  );
}

/* ------------------------------------------------------------ project plans -- */

export async function createProjectPlan(
  data: Partial<ProjectPlanRow> & { project_id: string },
  db?: DbDriver,
): Promise<ProjectPlanRow> {
  const timestamp = nowIso();
  const row: ProjectPlanRow = {
    id: data.id ?? crypto.randomUUID(),
    project_id: data.project_id,
    version: data.version ?? 1,
    status: data.status ?? "DRAFT",
    locale: data.locale ?? "ar",
    summary: data.summary ?? null,
    phases: data.phases ?? "[]",
    start_date: data.start_date ?? null,
    due_date: data.due_date ?? null,
    created_by_user_id: data.created_by_user_id ?? null,
    created_by_agent: data.created_by_agent ?? null,
    approved_by_user_id: data.approved_by_user_id ?? null,
    approved_at: data.approved_at ?? null,
    review_note: data.review_note ?? null,
    created_at: timestamp,
    updated_at: timestamp,
  };
  await insertRow("project_plans", row, db);
  return row;
}

export async function updateProjectPlan(
  id: string,
  data: Partial<ProjectPlanRow>,
  db?: DbDriver,
): Promise<ProjectPlanRow | undefined> {
  return updateRow<ProjectPlanRow>("project_plans", id, { ...clean(data), updated_at: nowIso() }, db);
}

export async function findProjectPlanById(id: string, db?: DbDriver): Promise<ProjectPlanRow | undefined> {
  return findRowById<ProjectPlanRow>("project_plans", id, db);
}

/** The newest plan of a project (the one the workflow acts on). */
export async function findLatestProjectPlan(
  projectId: string,
  db?: DbDriver,
): Promise<ProjectPlanRow | undefined> {
  const driver = db ?? (await getDb());
  return driver.get<ProjectPlanRow>(
    "SELECT * FROM project_plans WHERE project_id = ? ORDER BY version DESC LIMIT 1",
    [projectId],
  );
}

export async function listProjectPlans(
  projectId: string,
  db?: DbDriver,
): Promise<ProjectPlanRow[]> {
  const driver = db ?? (await getDb());
  return driver.query<ProjectPlanRow>(
    "SELECT * FROM project_plans WHERE project_id = ? ORDER BY version DESC",
    [projectId],
  );
}

/**
 * The plans of several projects at once (newest version first).
 *
 * The dashboards need both the working plan (the newest version) and the
 * approved one (the newest APPROVED version) without one query per project.
 */
export async function listProjectPlansForProjects(
  projectIds: string[],
  db?: DbDriver,
): Promise<ProjectPlanRow[]> {
  if (projectIds.length === 0) return [];
  const driver = db ?? (await getDb());
  const placeholders = projectIds.map(() => "?").join(", ");
  return driver.query<ProjectPlanRow>(
    `SELECT * FROM project_plans WHERE project_id IN (${placeholders}) ORDER BY project_id, version DESC`,
    projectIds,
  );
}

/**
 * The newest APPROVED plan of a project — the one the client is allowed to
 * see. A newer draft never replaces it until the owner approves it.
 */
export async function findLatestApprovedProjectPlan(
  projectId: string,
  db?: DbDriver,
): Promise<ProjectPlanRow | undefined> {
  const driver = db ?? (await getDb());
  return driver.get<ProjectPlanRow>(
    "SELECT * FROM project_plans WHERE project_id = ? AND status = 'APPROVED' ORDER BY version DESC LIMIT 1",
    [projectId],
  );
}

/** The next version number for a project plan. */
export async function nextPlanVersion(projectId: string, db?: DbDriver): Promise<number> {
  const driver = db ?? (await getDb());
  const row = await driver.get<{ total: number | null }>(
    "SELECT MAX(version) AS total FROM project_plans WHERE project_id = ?",
    [projectId],
  );
  return Number(row?.total ?? 0) + 1;
}
