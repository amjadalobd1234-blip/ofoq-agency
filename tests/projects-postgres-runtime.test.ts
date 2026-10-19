import fs from "node:fs";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The Projects API on a real PostgreSQL engine.
 *
 * The production deployment of Ofoq (Cloudflare/Netlify + Supabase) reaches
 * PostgreSQL through `DATABASE_URL` and the `pg` driver. This suite runs the
 * SAME repositories, services and route handlers against a real PostgreSQL
 * engine (PGlite — the WASM build of PostgreSQL), using:
 *
 *   * the generated PostgreSQL migrations (`db/migrations/postgres/*.sql`) —
 *     the exact files `npm run db:migrate` applies to a DATABASE_URL database,
 *   * the production placeholder translation (`toPositional` in
 *     `src/lib/db/postgres.ts`), so the `?` placeholders of the repositories
 *     become `$1, $2, …` exactly as in production,
 *   * the production int8 parsing, so a BIGINT column reads as a number.
 *
 * What this proves: every statement the Projects API sends is valid
 * PostgreSQL and returns the right rows. What it does not prove: the TCP
 * transport of the `pg` pool (unchanged by this pull request).
 */
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

const { toPositional, parsePostgresInt8 } = await import("../src/lib/db/postgres");
const { normaliseRow } = await import("../src/lib/db/types");
import type { DbDriver, Row, RunResult, SqlValue } from "../src/lib/db/types";
const { setDbForTesting } = await import("../src/lib/db");

const { POST: createProject } = await import("../src/app/api/projects/route");
const { GET: getProject } = await import("../src/app/api/projects/[id]/route");
const { POST: savePlan } = await import("../src/app/api/projects/[id]/plan/route");
const { POST: submitPlan } = await import("../src/app/api/projects/[id]/plan/submit/route");
const { POST: approvePlan } = await import("../src/app/api/projects/[id]/plan/approve/route");
const { PATCH: updateTask } = await import("../src/app/api/projects/[id]/tasks/[taskId]/route");
const { POST: closeProject } = await import("../src/app/api/projects/[id]/close/route");

/**
 * A DbDriver backed by a real PostgreSQL engine.
 *
 * It reuses the production translation and value normalisation, so the only
 * difference with the `pg` driver is the transport.
 */
class PGliteDriver implements DbDriver {
  readonly dialect = "postgres" as const;
  readonly target = "postgres://pglite/postgres";

  private depth = 0;

  constructor(private readonly db: PGlite) {}

  async query<T = Row>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    const { text, values } = toPositional(sql, params);
    const result = await this.db.query(text, values as unknown[]);
    const int8Columns = new Set(
      result.fields
        .map((field, index) => ({ index, id: (field as { dataTypeID?: number }).dataTypeID }))
        .filter((field) => field.id === 20)
        .map((field) => field.index),
    );
    return result.rows.map((row) => {
      const copy: Record<string, unknown> = { ...(row as Record<string, unknown>) };
      for (const index of int8Columns) {
        const key = result.fields[index]?.name;
        if (!key) continue;
        const value = copy[key];
        if (typeof value === "string") copy[key] = parsePostgresInt8(value);
      }
      return normaliseRow<T>(copy);
    });
  }

  async get<T = Row>(sql: string, params: SqlValue[] = []): Promise<T | undefined> {
    const rows = await this.query<T>(sql, params);
    return rows[0];
  }

  async run(sql: string, params: SqlValue[] = []): Promise<RunResult> {
    const { text, values } = toPositional(sql, params);
    const result = await this.db.query(text, values as unknown[]);
    return { changes: result.affectedRows ?? 0 };
  }

  async exec(sql: string): Promise<void> {
    await this.db.exec(sql);
  }

  async transaction<T>(fn: (tx: DbDriver) => Promise<T>): Promise<T> {
    if (this.depth > 0) return fn(this);
    await this.db.exec("BEGIN");
    this.depth += 1;
    try {
      const result = await fn(this);
      await this.db.exec("COMMIT");
      return result;
    } catch (error) {
      await this.db.exec("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      this.depth -= 1;
    }
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

function req(userId: string | null, body?: unknown, method = "GET", url = "/api/projects"): Request {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { "Content-Type": "application/json", ...(userId ? { "x-test-user": userId } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const taskCtx = (id: string, taskId: string) => ({ params: Promise.resolve({ id, taskId }) });

let db: PGlite;
let driver: PGliteDriver;
let ownerId = "";
let clientId = "";
let customerId = "";

beforeAll(async () => {
  db = new PGlite();

  // The migration runner creates the bookkeeping table before the files.
  await db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL, duration_ms BIGINT NOT NULL DEFAULT 0)`);

  // The generated PostgreSQL migrations — the same files that are applied to a
  // DATABASE_URL database with `npm run db:migrate`.
  const dir = path.join(process.cwd(), "db", "migrations", "postgres");
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".sql")).sort()) {
    await db.exec(fs.readFileSync(path.join(dir, file), "utf8"));
  }

  driver = new PGliteDriver(db);
  setDbForTesting(driver);

  const now = new Date().toISOString();
  await driver.run(
    `INSERT INTO users (id, email, name, role, status, locale, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["u-owner", "pg-owner@example.test", "Owner", "OWNER", "ACTIVE", "ar", now, now],
  );
  await driver.run(
    `INSERT INTO users (id, email, name, role, status, locale, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["u-client", "pg-client@example.test", "Client", "CLIENT", "ACTIVE", "ar", now, now],
  );
  await driver.run(
    `INSERT INTO customers (id, user_id, contact_name, email, country, locale, currency, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["c-1", "u-client", "عميل", "pg-client@example.test", "IQ", "ar", "USD", "ACTIVE", now, now],
  );
  await driver.run(
    `INSERT INTO services (id, slug, name_ar, name_en, category, billing_type, unit, base_price_minor,
                           min_price_minor, currency, delivery_days, complexity_factor, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "s-1", "seo", "تحسين محركات البحث", "SEO", "growth", "ONE_TIME", "PROJECT",
      250_00, 250_00, "USD", 30, 1, 1, now, now,
    ],
  );

  ownerId = "u-owner";
  clientId = "u-client";
  customerId = "c-1";
  profiles.byId.set(ownerId, { id: ownerId, role: "OWNER", status: "ACTIVE" });
  profiles.byId.set(clientId, { id: clientId, role: "CLIENT", status: "ACTIVE" });
});

afterAll(async () => {
  setDbForTesting(null);
  await driver?.close();
});

describe("the Projects API on PostgreSQL", () => {
  it("runs the whole cycle with the production SQL", async () => {
    // ── create ───────────────────────────────────────────────────────────
    const created = await createProject(
      req(ownerId, { customerId, title: "مشروع على PostgreSQL", serviceSlug: "seo" }, "POST"),
    );
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      data: { project: { id: string; code: string; status: string }; plan: { status: string; taskCount: number } };
    };
    const projectId = createdBody.data.project.id;
    expect(createdBody.data.project.status).toBe("DRAFT");
    expect(createdBody.data.plan.status).toBe("DRAFT");
    expect(createdBody.data.plan.taskCount).toBeGreaterThan(0);

    // The plan rows and the tasks exist in PostgreSQL with the right values.
    const plans = await driver.query<{ status: string; version: number }>(
      "SELECT status, version FROM project_plans WHERE project_id = $1 ORDER BY version",
      [projectId],
    );
    expect(plans).toHaveLength(1);
    expect(plans[0]!.status).toBe("DRAFT");
    // BIGINT columns come back as numbers, exactly as in production.
    expect(typeof plans[0]!.version).toBe("number");

    const tasks = await driver.query<{ title: string; phase_key: string | null; visibility: string }>(
      "SELECT title, phase_key, visibility FROM project_tasks WHERE project_id = $1 ORDER BY sort_order",
      [projectId],
    );
    expect(tasks.length).toBeGreaterThan(0);
    expect(tasks.every((task) => task.phase_key !== null)).toBe(true);

    // ── the client sees nothing before the approval ──────────────────────
    const draftView = await getProject(req(clientId, undefined, "GET", `/api/projects/${projectId}`), ctx(projectId));
    expect(draftView.status).toBe(200);
    const draftBody = (await draftView.json()) as { data: { plan: unknown; tasks: unknown[] } };
    expect(draftBody.data.plan).toBeNull();
    expect(draftBody.data.tasks).toEqual([]);

    // ── plan → submit → approve ─────────────────────────────────────────
    const saved = await savePlan(
      req(ownerId, {
        phases: [
          {
            key: "PREPARATION",
            title: "التحضير",
            dueDate: "2026-12-01",
            tasks: [{ title: "مراجعة تقنية للموقع", dueDate: "2026-11-20" }],
          },
        ],
      }, "POST", `/api/projects/${projectId}/plan`),
      ctx(projectId),
    );
    expect(saved.status).toBe(200);
    expect((await submitPlan(req(ownerId, {}, "POST", `/api/projects/${projectId}/plan/submit`), ctx(projectId))).status).toBe(200);
    expect((await approvePlan(req(ownerId, {}, "POST", `/api/projects/${projectId}/plan/approve`), ctx(projectId))).status).toBe(200);

    // ── the client sees the approved plan ───────────────────────────────
    const approvedView = await getProject(req(clientId, undefined, "GET", `/api/projects/${projectId}`), ctx(projectId));
    const approvedBody = (await approvedView.json()) as {
      data: { plan: { status: string; phases: unknown[] } | null; tasks: unknown[]; project: { status: string } };
    };
    expect(approvedBody.data.plan?.status).toBe("APPROVED");
    expect(approvedBody.data.plan?.phases.length).toBeGreaterThan(0);
    expect(approvedBody.data.tasks.length).toBeGreaterThan(0);
    expect(approvedBody.data.project.status).toBe("PLANNING");

    // ── execution: the progress comes from the real tasks ───────────────
    const clientTasks = await driver.query<{ id: string }>(
      "SELECT id FROM project_tasks WHERE project_id = $1 AND visibility = 'CLIENT'",
      [projectId],
    );
    const taskId = clientTasks[0]!.id;
    const updated = await updateTask(
      req(ownerId, { status: "DONE", note: "ملاحظة داخلية" }, "PATCH", `/api/projects/${projectId}/tasks/${taskId}`),
      taskCtx(projectId, taskId),
    );
    expect(updated.status).toBe(200);

    const progress = await driver.get<{ progress: number }>(
      "SELECT progress FROM projects WHERE id = $1",
      [projectId],
    );
    expect(Number(progress?.progress)).toBeGreaterThan(0);

    // The internal note stays in PostgreSQL, on the task, and never reaches
    // the client.
    const stored = await driver.get<{ internal_note: string | null }>(
      "SELECT internal_note FROM project_tasks WHERE id = $1",
      [taskId],
    );
    expect(stored?.internal_note).toContain("ملاحظة داخلية");
    const clientText = JSON.stringify(await (await getProject(req(clientId, undefined, "GET", `/api/projects/${projectId}`), ctx(projectId))).json());
    expect(clientText).not.toContain("ملاحظة داخلية");

    // ── close ───────────────────────────────────────────────────────────
    const openTasks = await driver.query<{ id: string }>(
      "SELECT id FROM project_tasks WHERE project_id = $1 AND visibility = 'CLIENT' AND status <> 'DONE'",
      [projectId],
    );
    for (const task of openTasks) {
      await updateTask(
        req(ownerId, { status: "DONE" }, "PATCH", `/api/projects/${projectId}/tasks/${task.id}`),
        taskCtx(projectId, task.id),
      );
    }
    const closed = await closeProject(req(ownerId, {}, "POST", `/api/projects/${projectId}/close`), ctx(projectId));
    expect(closed.status).toBe(200);
    const closedBody = (await closed.json()) as { data: { status: string; progress: number } };
    expect(closedBody.data.status).toBe("COMPLETED");
    expect(closedBody.data.progress).toBe(100);
  });

  it("answers the staff list on PostgreSQL", async () => {
    const response = await createProject(
      req(ownerId, { customerId, title: "مشروع القائمة", serviceSlug: "seo" }, "POST"),
    );
    expect(response.status).toBe(201);
    const list = await import("../src/app/api/projects/route");
    const staffList = await list.GET(req(ownerId));
    expect(staffList.status).toBe(200);
    const staffBody = (await staffList.json()) as { data: { rows: { code: string }[] } };
    expect(staffBody.data.rows.length).toBeGreaterThan(0);
    expect(staffBody.data.rows.every((row) => row.code.startsWith("OFQ-P-"))).toBe(true);
  });
});
