import fs from "node:fs";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * 0011 — a task of a phase that only exists in a DRAFT plan.
 *
 * The rule of the client portal is «no DRAFT content, no internal content, no
 * other customer». The first implementation of 0011 hid the tasks of a project
 * that had no approved plan at all, but a project that *did* have an approved
 * v1 and a newer draft v2 still leaked every CLIENT task of v2 on the dashboard
 * and in `ofoq_client_project_detail()` — including into the progress figure.
 *
 * These tests run the real migrations (0001 → 0008 → 0010 → 0011) on a real
 * PostgreSQL engine and pin the rule down:
 *
 *   * a committed phase (approved plan + client task) is visible;
 *   * a task that exists only in a newer draft is invisible — on the dashboard,
 *     in the detail RPC and in the progress percentage;
 *   * an internal task is never visible;
 *   * an owner's approval of the new version makes its phase and task visible;
 *   * another client's project stays unreachable.
 */
const setupBundle = fs.readFileSync(path.join(process.cwd(), "docs", "setup", "supabase-setup.sql"), "utf8");
const authMigration = fs.readFileSync(path.join(process.cwd(), "db", "migrations", "supabase", "0001_auth_portal.sql"), "utf8");
const serviceRequestMigration = fs.readFileSync(
  path.join(process.cwd(), "db", "migrations", "supabase", "0008_service_requests.sql"),
  "utf8",
);
const hardeningMigration = fs.readFileSync(
  path.join(process.cwd(), "db", "migrations", "supabase", "0010_harden_service_requests_and_offer_access.sql"),
  "utf8",
);
const projectPlanMigration = fs.readFileSync(
  path.join(process.cwd(), "db", "migrations", "supabase", "0011_project_plans.sql"),
  "utf8",
);

function tableDdl(name: string): string {
  const start = setupBundle.indexOf(`CREATE TABLE IF NOT EXISTS public.${name} (`);
  if (start < 0) throw new Error(`table ${name} not found in the setup bundle`);
  const end = setupBundle.indexOf("\n);", start);
  return setupBundle.slice(start, end + 3);
}

function functionDdlFrom(source: string, name: string, sourceName: string): string {
  const start = source.lastIndexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in ${sourceName}`);
  const end = source.indexOf("$function$;", start);
  return source.slice(start, end + "$function$;".length);
}

const setupTables = [...setupBundle.matchAll(/CREATE TABLE IF NOT EXISTS public\.([a-zA-Z_][a-zA-Z0-9_]*) \(/g)].map(
  (match) => match[1]!,
);

const OWNER_ID = "4d000000-0000-0000-0000-000000000001";
const CLIENT_ID = "4d000000-0000-0000-0000-000000000002";
const OTHER_CLIENT_ID = "4d000000-0000-0000-0000-000000000003";
const CUSTOMER_ID = "cust-4d00-1";
const OTHER_CUSTOMER_ID = "cust-4d00-2";
const PROJECT_ID = "proj-4d00-1";
const OTHER_PROJECT_ID = "proj-4d00-2";
const NOW = "2026-10-19T04:00:00.000Z";

let db: PGlite;

async function callAs<T>(userId: string, sql: string, params: unknown[] = []): Promise<T> {
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [userId]);
  await db.query("SET ROLE authenticated");
  try {
    const result = await db.query<{ result: T }>(sql, params);
    return result.rows[0]!.result;
  } finally {
    await db.query("RESET ROLE");
  }
}

function decode(value: unknown): Record<string, any> {
  if (typeof value === "string") return JSON.parse(value) as Record<string, any>;
  if (typeof value === "object" && value !== null) return value as Record<string, any>;
  throw new Error("Expected a JSON object from the RPC");
}

async function dashboardProject(): Promise<Record<string, any>> {
  const dashboard = decode(await callAs<unknown>(CLIENT_ID, "SELECT public.ofoq_client_dashboard() AS result"));
  const project = (dashboard.projects as Record<string, any>[]).find((row) => row.id === PROJECT_ID);
  expect(project).toBeTruthy();
  return project!;
}

async function projectDetail(): Promise<Record<string, any>> {
  return decode(
    await callAs<unknown>(CLIENT_ID, "SELECT public.ofoq_client_project_detail($1) AS result", [PROJECT_ID]),
  );
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
    LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    GRANT USAGE ON SCHEMA public TO anon, authenticated;
  `);
  for (const table of setupTables) await db.exec(tableDdl(table));

  // The deployed chain the migration is applied on top of.
  await db.exec(functionDdlFrom(authMigration, "ofoq_ensure_customer_profile", "0001_auth_portal.sql"));
  await db.exec(functionDdlFrom(authMigration, "ofoq_client_dashboard", "0001_auth_portal.sql"));
  await db.exec(functionDdlFrom(serviceRequestMigration, "ofoq_client_service_request", "0008_service_requests.sql"));
  await db.exec(hardeningMigration);

  // The migration under review, exactly as it ships.
  await db.exec(projectPlanMigration);

  await db.query(
    `INSERT INTO public.users (id, email, name, role, status, locale, created_at, updated_at)
     VALUES ($1, 'owner@ofoq.test', 'مالك', 'OWNER', 'ACTIVE', 'ar', $4, $4),
            ($2, 'client@ofoq.test', 'عميل', 'CLIENT', 'ACTIVE', 'ar', $4, $4),
            ($3, 'other@ofoq.test', 'عميل آخر', 'CLIENT', 'ACTIVE', 'ar', $4, $4)`,
    [OWNER_ID, CLIENT_ID, OTHER_CLIENT_ID, NOW],
  );
  await db.query(
    `INSERT INTO public.customers
       (id, user_id, company_name, contact_name, email, country, city, locale, currency, status, created_at, updated_at)
     VALUES ($1, $2, 'شركة العميل', 'عميل', 'client@ofoq.test', 'IQ', 'Basra', 'ar', 'USD', 'ACTIVE', $4, $4),
            ($3, $5, 'شركة أخرى', 'عميل آخر', 'other@ofoq.test', 'IQ', 'Baghdad', 'ar', 'USD', 'ACTIVE', $4, $4)`,
    [CUSTOMER_ID, CLIENT_ID, OTHER_CUSTOMER_ID, NOW, OTHER_CLIENT_ID],
  );
  await db.query(
    `INSERT INTO public.projects (id, code, customer_id, title, title_en, status, currency, progress,
                                  start_date, due_date, created_at, updated_at)
     VALUES ($1, 'OFOQ-P-401', $2, 'مشروع العميل', 'Client project', 'IN_PROGRESS', 'USD', 0,
             '2026-10-01', '2026-11-30', $4, $4),
            ($3, 'OFOQ-P-402', $5, 'مشروع آخر', 'Other project', 'IN_PROGRESS', 'USD', 0,
             '2026-10-01', '2026-11-30', $4, $4)`,
    [PROJECT_ID, CUSTOMER_ID, OTHER_PROJECT_ID, NOW, OTHER_CUSTOMER_ID],
  );

  // v1 APPROVED (phase PREP), v2 DRAFT (phases PREP + SECRET).
  await db.query(
    `INSERT INTO public.project_plans
       (id, project_id, version, status, locale, summary, phases, start_date, due_date,
        created_by_user_id, created_by_agent, approved_by_user_id, approved_at, created_at, updated_at)
     VALUES ('plan-4d00-v1', $1, 1, 'APPROVED', 'ar', 'الخطة المعتمدة',
             '[{"key":"PREP","title":"التحضير","dueDate":"2026-10-20"}]'::jsonb,
             '2026-10-01', '2026-11-30', $2, 'project_manager', $2, $3, $3, $3),
            ('plan-4d00-v2', $1, 2, 'DRAFT', 'ar', 'مسودة غير معتمدة',
             '[{"key":"PREP","title":"التحضير","dueDate":"2026-10-20"},
               {"key":"SECRET","title":"مرحلة في المسودة","dueDate":"2026-11-10"}]'::jsonb,
             '2026-10-01', '2026-11-30', $2, 'project_manager', NULL, NULL, $3, $3)`,
    [PROJECT_ID, OWNER_ID, NOW],
  );
  await db.query(
    `INSERT INTO public.project_tasks
       (id, project_id, title, title_en, status, visibility, sort_order, phase_key, internal_note, due_date, created_at, updated_at)
     VALUES ('task-4d00-hand', $1, 'مهمة بلا مرحلة', 'Hand task', 'TODO', 'CLIENT', 1, NULL, NULL, '2026-10-25', $3, $3),
            ('task-4d00-prep', $1, 'مهمة المرحلة المعتمدة', 'Approved phase task', 'DONE', 'CLIENT', 2, 'PREP', NULL, '2026-10-20', $3, $3),
            ('task-4d00-secret', $1, 'مهمة المرحلة غير المعتمدة', 'Draft phase task', 'DONE', 'CLIENT', 3, 'SECRET', NULL, '2026-11-05', $3, $3),
            ('task-4d00-internal', $1, 'مهمة داخلية', 'Internal task', 'TODO', 'INTERNAL', 4, 'PREP', 'ملاحظة سرية داخلية', '2026-10-21', $3, $3),
            ('task-4d00-other', $2, 'مهمة العميل الآخر', 'Other task', 'TODO', 'CLIENT', 1, NULL, NULL, '2026-10-21', $3, $3)`,
    [PROJECT_ID, OTHER_PROJECT_ID, NOW],
  );
});

afterAll(async () => {
  await db?.close();
});

describe("0011 — a task of a draft-only phase never reaches the client", () => {
  it("keeps the draft phase task out of the dashboard task list", async () => {
    const project = await dashboardProject();
    const titles = (project.tasks as Record<string, any>[]).map((task) => task.title);

    expect(titles).toEqual(["مهمة بلا مرحلة", "مهمة المرحلة المعتمدة"]);
    expect(JSON.stringify(project)).not.toContain("مهمة المرحلة غير المعتمدة");
    // The draft's own phase never appears either.
    expect(JSON.stringify(project)).not.toContain("مرحلة في المسودة");
    // And the internal task stays internal.
    expect(JSON.stringify(project)).not.toContain("مهمة داخلية");
    expect(JSON.stringify(project)).not.toContain("ملاحظة سرية داخلية");
  });

  it("serves the approved plan only, while the draft exists", async () => {
    const project = await dashboardProject();
    expect(project.plan).toMatchObject({ version: 1, status: "APPROVED", summary: "الخطة المعتمدة" });
    expect(project.plan.phases.map((phase: Record<string, any>) => phase.key)).toEqual(["PREP"]);
    expect(project.plan.phases[0].tasks).toEqual([
      expect.objectContaining({ title: "مهمة المرحلة المعتمدة", status: "DONE" }),
    ]);
  });

  it("keeps the draft phase task out of the detail RPC and the progress", async () => {
    const detail = await projectDetail();
    const titles = (detail.tasks as Record<string, any>[]).map((task) => task.title);
    expect(titles).toEqual(["مهمة بلا مرحلة", "مهمة المرحلة المعتمدة"]);
    // One of the two committed tasks is DONE → 50 %. Counting the draft task
    // (also DONE) would report 67 %, and counting the internal one would
    // report 33 %.
    expect(detail.project.progress).toBe(50);
    expect(detail.plan).toMatchObject({ version: 1, status: "APPROVED" });
  });

  it("shows the phase and its task once the owner approves the new version", async () => {
    // The owner's approval — the only thing that can make v2 a commitment.
    await db.query(
      `UPDATE public.project_plans SET status = 'SUPERSEDED', updated_at = $2
       WHERE project_id = $1 AND version = 1`,
      [PROJECT_ID, NOW],
    );
    await db.query(
      `UPDATE public.project_plans SET status = 'APPROVED', approved_by_user_id = $2,
              approved_at = $3, updated_at = $3
       WHERE project_id = $1 AND version = 2`,
      [PROJECT_ID, OWNER_ID, NOW],
    );

    const project = await dashboardProject();
    expect(project.plan).toMatchObject({ version: 2, status: "APPROVED", summary: "مسودة غير معتمدة" });
    expect(project.plan.phases.map((phase: Record<string, any>) => phase.key)).toEqual(["PREP", "SECRET"]);
    const titles = (project.tasks as Record<string, any>[]).map((task) => task.title);
    expect(titles).toContain("مهمة المرحلة غير المعتمدة");
    // The internal task is still invisible after the approval.
    expect(JSON.stringify(project)).not.toContain("مهمة داخلية");

    const detail = await projectDetail();
    expect(detail.project.progress).toBe(67); // 2 of 3 committed tasks are DONE
    expect((detail.tasks as Record<string, any>[]).map((task) => task.title)).toContain(
      "مهمة المرحلة غير المعتمدة",
    );
  });

  it("never opens another customer's project", async () => {
    await expect(
      callAs<unknown>(CLIENT_ID, "SELECT public.ofoq_client_project_detail($1) AS result", [OTHER_PROJECT_ID]),
    ).rejects.toThrow(/project not found/i);

    const dashboard = decode(await callAs<unknown>(CLIENT_ID, "SELECT public.ofoq_client_dashboard() AS result"));
    expect(JSON.stringify(dashboard)).not.toContain("مهمة العميل الآخر");
    expect((dashboard.projects as Record<string, any>[]).map((row) => row.id)).toEqual([PROJECT_ID]);
  });
});
