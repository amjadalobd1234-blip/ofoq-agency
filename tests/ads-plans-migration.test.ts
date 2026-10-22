/**
 * The ads-plan migration, executed on PostgreSQL (PGlite).
 *
 * `db/migrations/supabase/0012_ad_plans.sql` is a NEW migration: it is
 * documented in the pull request and NOT applied to any Supabase project from
 * here. These tests run the real file on a real PostgreSQL engine so the SQL
 * is proven before an operator applies it, and they prove the client portal
 * only ever receives the approved ads plan — never drafts or internal notes.
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
const adsPlanMigration = fs.readFileSync(
  path.join(process.cwd(), "db", "migrations", "supabase", "0012_ad_plans.sql"),
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

const STAFF_USER_ID = "a1c0b000-0000-0000-0000-000000000001";
const CLIENT_USER_ID = "a1c0b000-0000-0000-0000-000000000002";
const OTHER_CLIENT_USER_ID = "a1c0b000-0000-0000-0000-000000000003";
const CUSTOMER_ID = "cust-a1c0b-0000-0000-0000000000aa";
const OTHER_CUSTOMER_ID = "cust-a1c0b-0000-0000-0000000000bb";
const NOW = "2026-10-22T04:00:00.000Z";

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

  await db.exec(functionDdlFrom(authMigration, "ofoq_ensure_customer_profile", "0001_auth_portal.sql"));
  await db.exec(functionDdlFrom(authMigration, "ofoq_client_dashboard", "0001_auth_portal.sql"));

  await db.exec(adsPlanMigration);

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
    `INSERT INTO public.ad_plans
       (id, code, customer_id, project_id, family_key, version, status, locale, currency, summary, body, forecasts,
        internal_note, review_note, created_by_user_id, created_by_agent, approved_by_user_id, approved_at, created_at, updated_at)
     VALUES
       ('ad-approved', 'OFQ-AD-2026-0001', $1, NULL, $1, 1, 'APPROVED', 'ar', 'USD', 'خطة معتمدة',
        '{"disclaimerAr":"استشارية","disclaimerEn":"advisory","objective":"MESSAGES"}',
        '{"isEstimate":true,"disclaimerAr":"تقديرات"}',
        'ملاحظة داخلية سرية', 'مراجعة المالك', $3, 'ads_manager', $3, $2, $2, $2),
       ('ad-draft', 'OFQ-AD-2026-0001', $1, NULL, $1, 2, 'DRAFT', 'ar', 'USD', 'مسودة جديدة',
        '{"disclaimerAr":"مسودة"}', NULL, 'مسودة داخلية', NULL, $3, 'ads_manager', NULL, NULL, $2, $2),
       ('ad-other', 'OFQ-AD-2026-0002', $4, NULL, $4, 1, 'APPROVED', 'ar', 'USD', 'خطة عميل آخر',
        '{"disclaimerAr":"أخرى"}', NULL, 'داخلي للآخر', NULL, $3, 'ads_manager', $3, $2, $2, $2)`,
    [CUSTOMER_ID, NOW, STAFF_USER_ID, OTHER_CUSTOMER_ID],
  );
  await db.query(
    `INSERT INTO public.campaigns
       (id, customer_id, platform, name, status, currency, total_budget_minor, daily_budget_minor, monthly_budget_minor,
        spent_minor, sync_status, created_at, updated_at)
     VALUES
       ('camp-draft', $1, 'META_ADS', 'حملة مسودة', 'DRAFT', 'USD', 1000, 100, 1000, 0, 'NOT_CONNECTED', $2, $2),
       ('camp-active', $1, 'META_ADS', 'حملة ظاهرة', 'ACTIVE', 'USD', 1000, 100, 1000, 0, 'NOT_CONNECTED', $2, $2)`,
    [CUSTOMER_ID, NOW],
  );
});

afterAll(async () => {
  await db?.close();
});

describe("migration 0012 — ads plans in the client portal", () => {
  it("ships a manual SQL copy that matches the migration exactly", () => {
    const manualCopy = fs.readFileSync(
      path.join(process.cwd(), "docs", "setup", "ads-agent-migration.sql"),
      "utf8",
    );
    expect(manualCopy).toContain("خطوات التطبيق");
    expect(manualCopy).toContain("0012_ad_plans.sql");
    expect(manualCopy).toContain(adsPlanMigration.trim());
  });

  it("installs the client-safe dashboard and keeps the plan tables private", async () => {
    const privileges = await db.query<{ direct: boolean; execute: boolean; anonExecute: boolean }>(
      `SELECT has_table_privilege('authenticated', 'public.ad_plans', 'SELECT') AS direct,
              has_function_privilege('authenticated', 'public.ofoq_client_dashboard()', 'EXECUTE') AS execute,
              has_function_privilege('anon', 'public.ofoq_client_dashboard()', 'EXECUTE') AS "anonExecute"`,
    );
    expect(privileges.rows[0]).toEqual({ direct: false, execute: true, anonExecute: false });

    const rls = await db.query<{ enabled: boolean }>(
      `SELECT c.relrowsecurity AS enabled FROM pg_catalog.pg_class AS c WHERE c.oid = to_regclass('public.ad_plans')`,
    );
    expect(rls.rows[0]?.enabled).toBe(true);
  });

  it("returns the approved ads plan only and hides drafts, internal notes and draft campaigns", async () => {
    const dashboard = decodeJsonRecord(
      await callAsAuthenticated<unknown>(CLIENT_USER_ID, "SELECT public.ofoq_client_dashboard() AS result"),
    );
    const plans = dashboard.adPlans as Record<string, any>[];
    expect(plans.map((row) => row.id)).toEqual(["ad-approved"]);
    expect(plans[0]!.status).toBe("APPROVED");
    expect(plans[0]!.summary).toBe("خطة معتمدة");
    expect(JSON.stringify(dashboard)).not.toContain("ملاحظة داخلية سرية");
    expect(JSON.stringify(dashboard)).not.toContain("مسودة داخلية");
    expect(JSON.stringify(dashboard)).not.toContain("مسودة جديدة");

    const campaigns = dashboard.campaigns as Record<string, any>[];
    expect(campaigns.map((row) => row.id)).toEqual(["camp-active"]);
    expect(campaigns.map((row) => row.id)).not.toContain("camp-draft");
  });

  it("never returns another customer's ads plan", async () => {
    const dashboard = decodeJsonRecord(
      await callAsAuthenticated<unknown>(CLIENT_USER_ID, "SELECT public.ofoq_client_dashboard() AS result"),
    );
    const plans = dashboard.adPlans as Record<string, any>[];
    expect(plans.map((row) => row.id)).not.toContain("ad-other");

    const other = decodeJsonRecord(
      await callAsAuthenticated<unknown>(OTHER_CLIENT_USER_ID, "SELECT public.ofoq_client_dashboard() AS result"),
    );
    expect((other.adPlans as Record<string, any>[]).map((row) => row.id)).toEqual(["ad-other"]);
  });
});
