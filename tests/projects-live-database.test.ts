import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Live, READ-ONLY probe of the production PostgreSQL database.
 *
 * The suite is skipped unless the operator opts in, because no database
 * credential exists in this repository and the review must never touch
 * production by accident:
 *
 *   OFOQ_LIVE_DB_TEST=1 DATABASE_URL="postgres://…" \
 *     npx vitest run tests/projects-live-database.test.ts
 *
 * It only reads catalogs and runs `SELECT` statements — it never writes a row,
 * never creates an object and never applies a migration. That makes it safe to
 * point at the Supabase project of the agency to answer one question with
 * evidence instead of assumption: «does the deployed database carry the
 * objects `/api/projects` and the client contract expect?»
 */
const LIVE = process.env.OFOQ_LIVE_DB_TEST === "1" && Boolean(process.env.DATABASE_URL);

/**
 * The two methods this probe needs. `pg` ships without type declarations in
 * this repository (the driver imports it dynamically), so the shape is
 * declared here instead of adding a dependency for a read-only test.
 */
interface LiveClient {
  connect(): Promise<void>;
  end(): Promise<void>;
  query<T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

let client: LiveClient | null = null;
let failure: string | null = null;

describe.skipIf(!LIVE)("live PostgreSQL probe (read-only)", () => {
  beforeAll(async () => {
    // `pg` has no type declarations here; the driver imports it the same way.
    // @ts-expect-error -- untyped package, imported only when the probe is enabled
    const { Client } = (await import("pg")) as unknown as {
      Client: new (config: { connectionString?: string }) => LiveClient;
    };
    client = new Client({ connectionString: process.env.DATABASE_URL });
    try {
      await client.connect();
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }, 30_000);

  afterAll(async () => {
    await client?.end().catch(() => undefined);
  });

  it("connects to DATABASE_URL", async () => {
    expect(failure).toBeNull();
    const result = await client!.query<{ ok: number }>("SELECT 1 AS ok");
    expect(Number(result.rows[0]?.ok)).toBe(1);
  });

  it("carries every table and column the Projects API writes", async () => {
    const required = [
      "projects",
      "project_tasks",
      "project_plans",
      "project_services",
      "customers",
      "users",
      "offers",
      "activities",
      "alerts",
      "notifications",
    ];
    const tables = await client!.query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_catalog.pg_class AS c
       JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'`,
    );
    const present = new Set(tables.rows.map((row) => row.name));
    const missing = required.filter((table) => !present.has(table));
    expect(missing, `missing tables — run npm run db:migrate against DATABASE_URL: ${missing.join(", ")}`).toEqual([]);

    const columns = await client!.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND (
         (table_name = 'project_tasks' AND column_name IN ('phase_key', 'internal_note')) OR
         (table_name = 'project_plans' AND column_name IN ('phases', 'status', 'approved_at'))
       )`,
    );
    const presentColumns = new Set(columns.rows.map((row) => `${row.table_name}.${row.column_name}`));
    expect(presentColumns).toEqual(
      new Set([
        "project_tasks.phase_key",
        "project_tasks.internal_note",
        "project_plans.phases",
        "project_plans.status",
        "project_plans.approved_at",
      ]),
    );
  });

  it("carries the Supabase portal objects, and 0011 stays unapplied until the owner runs it", async () => {
    const functions = await client!.query<{ signature: string }>(
      `SELECT p.oid::regprocedure::text AS signature
       FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname IN ('ofoq_client_dashboard', 'ofoq_client_project_detail')`,
    );
    const signatures = functions.rows.map((row) => row.signature);

    // The dashboard has been deployed with 0010 (offer allowlist, own customer).
    expect(signatures.some((signature) => signature.startsWith("ofoq_client_dashboard("))).toBe(true);
    if (!signatures.some((signature) => signature.startsWith("ofoq_client_project_detail("))) {
      throw new Error(
        "public.ofoq_client_project_detail(text) is missing: db/migrations/supabase/0011_project_plans.sql " +
          "has NOT been applied to this database. Apply it manually in the Supabase SQL Editor — never from CI.",
      );
    }
  });

  it("keeps the plan table private and the client RPC callable by authenticated only", async () => {
    const rls = await client!.query<{ rls: boolean; anon_read: boolean; authenticated_read: boolean }>(
      `SELECT c.relrowsecurity AS rls,
              has_table_privilege('anon', 'public.project_plans', 'SELECT') AS anon_read,
              has_table_privilege('authenticated', 'public.project_plans', 'SELECT') AS authenticated_read
       FROM pg_catalog.pg_class AS c WHERE c.oid = to_regclass('public.project_plans')`,
    );
    expect(rls.rows[0]).toEqual({ rls: true, anon_read: false, authenticated_read: false });

    const grants = await client!.query<{ anon: boolean; authenticated: boolean }>(
      `SELECT has_function_privilege('anon', 'public.ofoq_client_dashboard()', 'EXECUTE') AS anon,
              has_function_privilege('authenticated', 'public.ofoq_client_dashboard()', 'EXECUTE') AS authenticated`,
    );
    expect(grants.rows[0]).toEqual({ anon: false, authenticated: true });
  });
});

if (!LIVE) {
  describe("live PostgreSQL probe", () => {
    it("is skipped: set OFOQ_LIVE_DB_TEST=1 and DATABASE_URL to run it read-only", () => {
      expect(process.env.OFOQ_LIVE_DB_TEST).not.toBe("1");
    });
  });
}
