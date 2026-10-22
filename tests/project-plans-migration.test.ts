/**
 * The project-plan migration, executed on PostgreSQL (PGlite).
 *
 * `db/migrations/supabase/0011_project_plans.sql` is a NEW migration: it is
 * documented in the pull request and NOT applied to any Supabase project from
 * here. These tests run the real file on a real PostgreSQL engine so the SQL
 * is proven before an operator applies it, and they prove the client portal
 * only ever receives the approved plan with the client-visible tasks.
 */
import fs from "node:fs";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const setupBundle = fs.readFileSync(path.join(process.cwd(), "docs", "setup", "supabase-setup.sql"), "utf8");
const authMigration = fs.readFileSync(
  path.join(process.cwd(), "db", "migrations", "supabase", "0001_auth_portal.sql"),
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

const STAFF_USER_ID = "e1c0b000-0000-0000-0000-000000000001";
const CLIENT_USER_ID = "e1c0b000-0000-0000-0000-000000000002";
const OTHER_CLIENT_USER_ID = "e1c0b000-0000-0000-0000-000000000003";
const CUSTOMER_ID = "cust-e1c0b-0000-0000-0000000000aa";
const OTHER_CUSTOMER_ID = "cust-e1c0b-0000-0000-0000000000bb";
const PROJECT_ID = "proj-e1c0b-own";
const OTHER_PROJECT_ID = "proj-e1c0b-other";
const NOW = "2026-10-19T04:00:00.000Z";

let db: PGlite;

async function callAsAuthenticated<T>(userId: string, sql: string, params: unknown[] = []): Promise<T> {
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [userId]);
  await db.query("SET ROLE authenticated");
  try {
    const result = await db.query<{ result: T }>(sql, params);
    return result.rows[0]!.result;
  } finally {
    await db.query("RESET ROLE");
  }
}

function decodeJsonRecord(value: unknown): Record<string, any> {
  if (typeof value === "string") return JSON.parse(value) as Record<string, any>;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, any>;
  throw new Error("Expected a JSON object returned by the RPC");
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

  // The portal objects the migration builds on.
  await db.exec(functionDdlFrom(authMigration, "ofoq_ensure_customer_profile", "0001_auth_portal.sql"));
  await db.exec(functionDdlFrom(authMigration, "ofoq_client_dashboard", "0001_auth_portal.sql"));

  // The migration under test, applied exactly as it ships.
  await db.exec(projectPlanMigration);

  await db.query(
    `INSERT INTO public.users (id, email, name, role, status, locale, created_at, updated_at)
     VALUES ($1, 'owner@ofoq.test', 'مالك', 'OWNER', 'ACTIVE', 'ar', $4, $4),
            ($2, 'client@ofoq.test', 'عميل', 'CLIENT', 'ACTIVE', 'ar', $4, $4),
            ($3, 'other@ofoq.test', 'عميل آخر', 'CLIENT', 'ACTIVE', 'ar', $4, $4)`,
    [STAFF_USER_ID, CLIENT_USER_ID, OTHER_CLIENT_USER_ID, NOW],
  );
  await db.query(
    `INSERT INTO public.customers
       (id, user_id, company_name, contact_name, email, country, city, locale, currency, status, created_at, updated_at)
     VALUES ($1, $2, 'شركة العميل', 'عميل', 'client@ofoq.test', 'IQ', 'Basra', 'ar', 'USD', 'ACTIVE', $3, $3),
            ($4, $5, 'شركة أخرى', 'عميل آخر', 'other@ofoq.test', 'IQ', 'Baghdad', 'ar', 'USD', 'ACTIVE', $3, $3)`,
    [CUSTOMER_ID, CLIENT_USER_ID, NOW, OTHER_CUSTOMER_ID, OTHER_CLIENT_USER_ID],
  );
  await db.query(
    `INSERT INTO public.projects (id, code, customer_id, title, title_en, status, currency, progress,
                                  start_date, due_date, created_at, updated_at)
     VALUES ($1, 'OFOQ-P-001', $2, 'مشروع العميل', 'Client project', 'PLANNING', 'USD', 50,
             '2026-10-01', '2026-11-30', $3, $3),
            ($4, 'OFOQ-P-002', $5, 'مشروع آخر', 'Other project', 'PLANNING', 'USD', 0,
             '2026-10-01', '2026-11-30', $3, $3)`,
    [PROJECT_ID, CUSTOMER_ID, NOW, OTHER_PROJECT_ID, OTHER_CUSTOMER_ID],
  );
  await db.query(
    `INSERT INTO public.project_tasks (id, project_id, title, title_en, status, visibility, sort_order,
                                       phase_key, internal_note, due_date, created_at, updated_at)
     VALUES ('task-client', $1, 'مهمة ظاهرة', 'Visible task', 'DONE', 'CLIENT', 1, 'PREP', NULL, '2026-10-20', $2, $2),
            ('task-internal', $1, 'مهمة داخلية', 'Internal task', 'TODO', 'INTERNAL', 2, 'PREP', 'ملاحظة سرية', '2026-10-20', $2, $2),
            ('task-other-phase', $1, 'مهمة مرحلة أخرى', 'Other phase task', 'TODO', 'CLIENT', 3, 'DELIVERY', NULL, '2026-11-01', $2, $2)`,
    [PROJECT_ID, NOW],
  );
  await db.query(
    `INSERT INTO public.project_plans
       (id, project_id, version, status, locale, summary, phases, start_date, due_date,
        created_by_user_id, created_by_agent, approved_by_user_id, approved_at, created_at, updated_at)
     VALUES ('plan-approved', $1, 1, 'APPROVED', 'ar', 'خطة معتمدة',
             '[{"key":"PREP","title":"التحضير","dueDate":"2026-10-25","tasks":[{"title":"مهمة مرحلة أخرى"}]},
               {"key":"DELIVERY","title":"التسليم","dueDate":"2026-11-25","tasks":[{"title":"مهمة مرحلة أخرى"}]},
               {"key":"HIDDEN","title":"مرحلة داخلية","tasks":[]}]'::jsonb,
             '2026-10-01', '2026-11-30', $3, 'project_manager', $3, $2, $2, $2),
            ('plan-draft', $1, 2, 'DRAFT', 'ar', 'مسودة',
             '[{"key":"PREP","title":"مسودة","tasks":[]}]'::jsonb,
             '2026-10-01', '2026-11-30', $3, 'project_manager', NULL, NULL, $2, $2)`,
    [PROJECT_ID, NOW, STAFF_USER_ID],
  );
});

afterAll(async () => {
  await db?.close();
});

describe("migration 0011 — project plans in the client portal", () => {
  it("ships a manual SQL copy that matches the migration exactly", () => {
    const manualCopy = fs.readFileSync(
      path.join(process.cwd(), "docs", "setup", "projects-agent-migration.sql"),
      "utf8",
    );
    expect(manualCopy).toContain("خطوات التطبيق");
    expect(manualCopy).toContain("0011_project_plans.sql");
    expect(manualCopy).toContain(projectPlanMigration.trim());
  });

  it("installs the client-safe plan RPC and keeps the plan table private", async () => {
    const privileges = await db.query<{ direct: boolean; execute: boolean; anonExecute: boolean }>(
      `SELECT has_table_privilege('authenticated', 'public.project_plans', 'SELECT') AS direct,
              has_function_privilege('authenticated', 'public.ofoq_client_project_detail(text)', 'EXECUTE') AS execute,
              has_function_privilege('anon', 'public.ofoq_client_project_detail(text)', 'EXECUTE') AS "anonExecute"`,
    );
    expect(privileges.rows[0]).toEqual({ direct: false, execute: true, anonExecute: false });

    const rls = await db.query<{ enabled: boolean }>(
      `SELECT c.relrowsecurity AS enabled FROM pg_catalog.pg_class AS c WHERE c.oid = to_regclass('public.project_plans')`,
    );
    expect(rls.rows[0]?.enabled).toBe(true);
  });

  it("returns the approved plan with the client-visible tasks only", async () => {
    const dashboard = decodeJsonRecord(
      await callAsAuthenticated<unknown>(CLIENT_USER_ID, "SELECT public.ofoq_client_dashboard() AS result"),
    );
    const project = (dashboard.projects as Record<string, any>[]).find((row) => row.id === PROJECT_ID);
    expect(project).toBeTruthy();
    expect(project!.plan).toMatchObject({ version: 1, status: "APPROVED", summary: "خطة معتمدة" });

    const phases = project!.plan.phases as Record<string, any>[];
    // The phase without a client-visible task is not returned.
    expect(phases.map((phase) => phase.key)).toEqual(["PREP", "DELIVERY"]);
    const prep = phases.find((phase) => phase.key === "PREP")!;
    expect(prep.tasks).toEqual([expect.objectContaining({ title: "مهمة ظاهرة", status: "DONE" })]);
    // The internal task and its note never reach the client.
    expect(JSON.stringify(project)).not.toContain("مهمة داخلية");
    expect(JSON.stringify(project)).not.toContain("ملاحظة سرية");
  });

  it("keeps the tasks of an unapproved plan away from the client", async () => {
    // A second project whose plan was never approved: its tasks are still a
    // proposal and must not reach the client.
    await db.query(
      `INSERT INTO public.projects (id, code, customer_id, title, title_en, status, currency, progress,
                                    start_date, due_date, created_at, updated_at)
       VALUES ('proj-e1c0b-draft', 'OFOQ-P-003', $1, 'مشروع مسودة', 'Draft project', 'DRAFT', 'USD', 0,
               '2026-10-01', '2026-11-30', $2, $2)`,
      [CUSTOMER_ID, NOW],
    );
    await db.query(
      `INSERT INTO public.project_tasks (id, project_id, title, title_en, status, visibility, sort_order,
                                         phase_key, internal_note, due_date, created_at, updated_at)
       VALUES ('task-draft', 'proj-e1c0b-draft', 'مهمة مسودة', 'Draft task', 'TODO', 'CLIENT', 1, 'PREP',
               NULL, '2026-10-20', $1, $1)`,
      [NOW],
    );
    await db.query(
      `INSERT INTO public.project_plans
         (id, project_id, version, status, locale, summary, phases, start_date, due_date,
          created_by_user_id, created_by_agent, approved_by_user_id, approved_at, created_at, updated_at)
       VALUES ('plan-draft-only', 'proj-e1c0b-draft', 1, 'DRAFT', 'ar', 'مسودة فقط',
               '[{"key":"PREP","title":"التحضير","tasks":[]}]'::jsonb,
               '2026-10-01', '2026-11-30', $1, 'project_manager', NULL, NULL, $2, $2)`,
      [STAFF_USER_ID, NOW],
    );

    const dashboard = decodeJsonRecord(
      await callAsAuthenticated<unknown>(CLIENT_USER_ID, "SELECT public.ofoq_client_dashboard() AS result"),
    );
    const draftProject = (dashboard.projects as Record<string, any>[]).find(
      (row) => row.id === "proj-e1c0b-draft",
    );
    expect(draftProject).toBeTruthy();
    expect(draftProject!.plan).toBeNull();
    expect(draftProject!.tasks).toEqual([]);

    const detail = decodeJsonRecord(
      await callAsAuthenticated<unknown>(
        CLIENT_USER_ID,
        "SELECT public.ofoq_client_project_detail($1) AS result",
        ["proj-e1c0b-draft"],
      ),
    );
    expect(detail.plan).toBeNull();
    expect(detail.tasks).toEqual([]);
    expect(detail.project.progress).toBe(0);
  });

  it("never returns the draft plan of an unapproved version", async () => {
    const dashboard = decodeJsonRecord(
      await callAsAuthenticated<unknown>(CLIENT_USER_ID, "SELECT public.ofoq_client_dashboard() AS result"),
    );
    const project = (dashboard.projects as Record<string, any>[]).find((row) => row.id === PROJECT_ID);
    expect(project!.plan.status).toBe("APPROVED");
    expect(project!.plan.summary).not.toBe("مسودة");
  });

  it("serves the client-safe detail of the own project and refuses the others", async () => {
    const detail = decodeJsonRecord(
      await callAsAuthenticated<unknown>(
        CLIENT_USER_ID,
        "SELECT public.ofoq_client_project_detail($1) AS result",
        [PROJECT_ID],
      ),
    );
    expect(detail.project).toMatchObject({ id: PROJECT_ID, status: "PLANNING" });
    expect(detail.project.progress).toBe(50);
    expect(detail.tasks).toEqual([
      expect.objectContaining({ id: "task-client" }),
      expect.objectContaining({ id: "task-other-phase" }),
    ]);
    expect(detail.plan.status).toBe("APPROVED");

    // Another client's project is not readable.
    await expect(
      callAsAuthenticated<unknown>(
        CLIENT_USER_ID,
        "SELECT public.ofoq_client_project_detail($1) AS result",
        [OTHER_PROJECT_ID],
      ),
    ).rejects.toThrow(/project not found/i);
  });
});
