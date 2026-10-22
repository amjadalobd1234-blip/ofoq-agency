import fs from "node:fs";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The production PostgreSQL driver (`src/lib/db/postgres.ts`) on a real engine.
 *
 * `tests/projects-postgres-runtime.test.ts` proves the *SQL* of the Projects API
 * is valid PostgreSQL, but it runs it through a test driver that copies the
 * placeholder translation by hand. This suite removes that gap: it keeps the
 * REAL `PostgresDriver` — `create()` (which loads `pg`), `toPositional`, the
 * int8 type parser, `execute()` and the pool/transaction contract — and only
 * replaces the transport (`pg.Pool`) with a connection to a real PostgreSQL
 * engine (PGlite).
 *
 * What it proves:
 *   * `npm run db:migrate`'s runner applies every generated PostgreSQL
 *     migration through the production driver, and records them in
 *     `_migrations` — the same bookkeeping a `DATABASE_URL` deployment has;
 *   * `/api/projects*` runs end-to-end (create → plan → submit → approve →
 *     task → close) with the production SQL translation and value handling;
 *   * a failed transaction rolls back and a `?` inside a string literal is not
 *     mistaken for a placeholder.
 *
 * What it does not prove: the TCP/TLS transport to the real Supabase host and
 * the deployed environment variables. No database credential exists in this
 * repository, so a live round-trip is opt-in and read-only —
 * see `tests/projects-live-database.test.ts`.
 */
interface MockResult {
  rows: Record<string, unknown>[];
  fields?: { name: string; dataTypeID?: number }[];
  affectedRows?: number;
}

const holder = vi.hoisted(() => ({
  db: null as null | ((sql: string, params?: unknown[]) => Promise<MockResult>),
  /** OID → parser, registered by `PostgresDriver.create` through `pg.types`. */
  parsers: new Map<number, (value: string) => unknown>(),
}));

vi.mock("pg", () => {
  async function run(sql: string, params?: unknown[]) {
    if (!holder.db) throw new Error("pg transport mock: no PostgreSQL engine attached");
    const result = await holder.db(sql, params ?? []);
    const fields = result.fields ?? [];
    const rows = (result.rows ?? []).map((row) => {
      const copy: Record<string, unknown> = { ...row };
      for (const field of fields) {
        const parser = holder.parsers.get(field.dataTypeID ?? -1);
        const value = copy[field.name];
        // node-postgres returns int8 as text and converts it with the parser
        // installed by the driver; keep that shape so the parser is exercised.
        if (parser && typeof value === "string") copy[field.name] = parser(value);
      }
      return copy;
    });
    const rowCount = fields.length > 0 ? rows.length : (result.affectedRows ?? 0);
    return { rows, rowCount };
  }

  class Pool {
    constructor(readonly config: { connectionString: string }) {}
    query(sql: string, params?: unknown[]) {
      return run(sql, params);
    }
    async connect() {
      return { query: run, release: () => undefined };
    }
    async end() {
      // The engine is owned by the test.
    }
  }

  return {
    Pool,
    default: { Pool },
    types: { setTypeParser: (oid: number, parser: (value: string) => unknown) => holder.parsers.set(oid, parser) },
  };
});

const { PostgresDriver } = await import("../src/lib/db/postgres");
type Driver = import("../src/lib/db/types").DbDriver;
const { runMigrations } = await import("../src/lib/db/migrate");
const { setDbForTesting } = await import("../src/lib/db");

const profiles = vi.hoisted(() => ({ byId: new Map<string, { id: string; role: string; status: string }>() }));

vi.mock("@/lib/supabase/config", () => ({
  getSupabaseConfig: () => ({ url: "https://test.supabase.co", anonKey: "test" }),
}));

vi.mock("@/lib/supabase/route-auth", () => ({
  requireSupabaseUser: (request: Request) => {
    const id = request.headers.get("x-test-user");
    if (!id) return Promise.resolve({ response: Response.json({ error: "auth" }, { status: 401 }) });
    return Promise.resolve({
      client: {}, user: { id }, requestId: "test",
      finalize: (response: Response) => response,
    });
  },
  fetchOwnProfile: (_client: unknown, id: string) => {
    const profile = profiles.byId.get(id);
    return Promise.resolve(profile ? { profile } : { error: { code: "NO_PROFILE", message: "none" } });
  },
}));

const { POST: createProject, GET: listProjects } = await import("../src/app/api/projects/route");
const { GET: getProject } = await import("../src/app/api/projects/[id]/route");
const { POST: savePlan } = await import("../src/app/api/projects/[id]/plan/route");
const { POST: submitPlan } = await import("../src/app/api/projects/[id]/plan/submit/route");
const { POST: approvePlan } = await import("../src/app/api/projects/[id]/plan/approve/route");
const { PATCH: updateTask } = await import("../src/app/api/projects/[id]/tasks/[taskId]/route");
const { POST: closeProject } = await import("../src/app/api/projects/[id]/close/route");

const OWNER = "u-owner";
const CLIENT = "u-client";
const CUSTOMER = "c-1";

let driver: Driver;
let engine: PGlite;

function req(userId: string | null, body?: unknown, method = "GET", url = "/api/projects"): Request {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { "Content-Type": "application/json", ...(userId ? { "x-test-user": userId } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeAll(async () => {
  engine = new PGlite();
  holder.db = (sql, params) => engine.query<Record<string, unknown>>(sql, params as unknown[]) as Promise<MockResult>;

  // The production driver: real create(), real placeholder translation, real
  // int8 parser and transaction handling.
  driver = (await PostgresDriver.create("postgres://ofoq:secret@db.example.test:5432/ofoq")) as Driver;
  expect(driver.dialect).toBe("postgres");
  expect(driver.target).not.toContain("secret");

  // `npm run db:migrate` on PostgreSQL, through the same runner.
  await runMigrations(driver, { rootDir: process.cwd() });
  setDbForTesting(driver);

  const now = new Date().toISOString();
  await driver.run(
    `INSERT INTO users (id, email, name, role, status, locale, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [OWNER, "pg-owner@example.test", "Owner", "OWNER", "ACTIVE", "ar", now, now],
  );
  await driver.run(
    `INSERT INTO users (id, email, name, role, status, locale, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [CLIENT, "pg-client@example.test", "Client", "CLIENT", "ACTIVE", "ar", now, now],
  );
  await driver.run(
    `INSERT INTO customers (id, user_id, contact_name, email, country, locale, currency, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [CUSTOMER, CLIENT, "عميل", "pg-client@example.test", "IQ", "ar", "USD", "ACTIVE", now, now],
  );
  await driver.run(
    `INSERT INTO services (id, slug, name_ar, name_en, category, billing_type, unit, base_price_minor,
                           min_price_minor, currency, delivery_days, complexity_factor, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["s-1", "seo", "تحسين محركات البحث", "SEO", "growth", "ONE_TIME", "PROJECT", 250_00, 250_00, "USD", 30, 1, 1, now, now],
  );

  profiles.byId.set(OWNER, { id: OWNER, role: "OWNER", status: "ACTIVE" });
  profiles.byId.set(CLIENT, { id: CLIENT, role: "CLIENT", status: "ACTIVE" });
});

afterAll(async () => {
  setDbForTesting(null);
  await driver?.close();
  await engine?.close();
});

describe("the production PostgreSQL driver", () => {
  it("applies the generated migrations through the real runner", async () => {
    const generated = fs
      .readdirSync(path.join(process.cwd(), "db", "migrations", "postgres"))
      .filter((file) => file.endsWith(".sql"))
      .sort();
    const applied = await driver.query<{ id: string }>("SELECT id FROM _migrations ORDER BY id");
    expect(applied.map((row) => row.id)).toEqual(generated.map((file) => file.split("_")[0]));

    // The plan table and the two task columns the Projects Agent needs.
    const columns = await driver.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND (
         (table_name = 'project_plans' AND column_name IN ('id', 'phases', 'status', 'approved_at')) OR
         (table_name = 'project_tasks' AND column_name IN ('phase_key', 'internal_note'))
       )`,
    );
    expect(new Set(columns.map((row) => `${row.table_name}.${row.column_name}`))).toEqual(
      new Set([
        "project_plans.id",
        "project_plans.phases",
        "project_plans.status",
        "project_plans.approved_at",
        "project_tasks.phase_key",
        "project_tasks.internal_note",
      ]),
    );
  });

  it("translates placeholders without touching string literals", async () => {
    const row = await driver.get<{ literal: string; value: number }>(
      "SELECT '?' AS literal, (?::int) AS value",
      [42],
    );
    expect(row).toEqual({ literal: "?", value: 42 });

    // `create()` installed the int8 parser, so a BIGINT column reads as a
    // number in production exactly as the schema expects.
    expect(holder.parsers.has(20)).toBe(true);
  });

  it("rolls a failed transaction back", async () => {
    await expect(
      driver.transaction(async (tx) => {
        await tx.run(
          `INSERT INTO users (id, email, name, role, status, locale, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ["u-rollback", "rollback@example.test", "Rollback", "CLIENT", "ACTIVE", "ar", "2026-10-19", "2026-10-19"],
        );
        throw new Error("forced failure");
      }),
    ).rejects.toThrow(/forced failure/);
    const found = await driver.get<{ id: string }>("SELECT id FROM users WHERE id = ?", ["u-rollback"]);
    expect(found).toBeUndefined();
  });

  it("runs the whole Projects cycle through the production driver", async () => {
    const created = await createProject(
      req(OWNER, { customerId: CUSTOMER, title: "مشروع PostgreSQL الحقيقي", serviceSlug: "seo" }, "POST"),
    );
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      data: { project: { id: string; status: string }; plan: { status: string; taskCount: number } };
    };
    const projectId = createdBody.data.project.id;
    expect(createdBody.data.project.status).toBe("DRAFT");
    expect(createdBody.data.plan.status).toBe("DRAFT");

    // The client sees no plan and no task before the owner's approval.
    const before = (await (
      await getProject(req(CLIENT, undefined, "GET", `/api/projects/${projectId}`), ctx(projectId))
    ).json()) as { data: { plan: unknown; tasks: unknown[] } };
    expect(before.data.plan).toBeNull();
    expect(before.data.tasks).toEqual([]);

    const saved = await savePlan(
      req(
        OWNER,
        {
          phases: [
            {
              key: "PREPARATION",
              title: "التحضير",
              dueDate: "2026-12-01",
              tasks: [{ title: "مراجعة تقنية للموقع", dueDate: "2026-11-20" }],
            },
          ],
        },
        "POST",
        `/api/projects/${projectId}/plan`,
      ),
      ctx(projectId),
    );
    expect(saved.status).toBe(200);
    expect(
      (await submitPlan(req(OWNER, {}, "POST", `/api/projects/${projectId}/plan/submit`), ctx(projectId))).status,
    ).toBe(200);
    expect(
      (await approvePlan(req(OWNER, {}, "POST", `/api/projects/${projectId}/plan/approve`), ctx(projectId))).status,
    ).toBe(200);

    const approved = (await (
      await getProject(req(CLIENT, undefined, "GET", `/api/projects/${projectId}`), ctx(projectId))
    ).json()) as { data: { plan: { status: string } | null; tasks: { id: string }[] } };
    expect(approved.data.plan?.status).toBe("APPROVED");
    expect(approved.data.tasks.length).toBeGreaterThan(0);

    // The status comes from the staff list of the same driver.
    const staffList = await listProjects(req(OWNER));
    expect(staffList.status).toBe(200);

    // Execution + closing, so the remaining write paths are covered too.
    for (const task of approved.data.tasks) {
      expect(
        (
          await updateTask(
            req(OWNER, { status: "DONE" }, "PATCH", `/api/projects/${projectId}/tasks/${task.id}`),
            { params: Promise.resolve({ id: projectId, taskId: task.id }) },
          )
        ).status,
      ).toBe(200);
    }
    const closed = await closeProject(req(OWNER, {}, "POST", `/api/projects/${projectId}/close`), ctx(projectId));
    expect(closed.status).toBe(200);
    const closedBody = (await closed.json()) as { data: { status: string; progress: number } };
    expect(closedBody.data.status).toBe("COMPLETED");
    expect(closedBody.data.progress).toBe(100);
  });
});
