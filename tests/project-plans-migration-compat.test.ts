import fs from "node:fs";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Migration 0011 on top of migration 0010 — compatibility and exposure proof.
 *
 * The portal of Ofoq runs on Supabase. 0010 hardened the client dashboard
 * (published offers only, own customer only, no internal columns). 0011
 * replaces `ofoq_client_dashboard()` once more to add the approved plan.
 *
 * This suite runs the real migration files, in the real order, on a real
 * PostgreSQL engine (PGlite) and compares the dashboard BEFORE (0010) and
 * AFTER (0011):
 *
 *   * every offer / invoice / customer field the 0010 dashboard returned is
 *     still returned, unchanged — including the fact that DRAFT offers and
 *     the other customer's records stay hidden;
 *   * the only new thing is the `plan` projection and the rule that a task of
 *     an unapproved plan stays a proposal;
 *   * no internal column of any table reaches the client;
 *   * the objects 0010 created still exist after 0011 (no dropped policy, no
 *     re-granted table access).
 *
 * Nothing is applied to any Supabase project from here.
 */
const bundle = fs.readFileSync(path.join(process.cwd(), "docs", "setup", "supabase-setup.sql"), "utf8");

/** The migrations of the portal, in the order they are deployed. */
const MIGRATION_FILES = [
  "db/migrations/supabase/0001_auth_portal.sql",
  "db/migrations/supabase/0002_ai_usage.sql",
  "db/migrations/supabase/0003_escalation_alerts.sql",
  "db/migrations/supabase/0004_escalation_owner_support.sql",
  "db/migrations/supabase/0006_escalate_manual_overload.sql",
  "db/migrations/supabase/0007_admin_alerts.sql",
  "db/migrations/supabase/0008_service_requests.sql",
  "db/migrations/supabase/pending/0009_offers_requested_status.sql",
  "db/migrations/supabase/0010_harden_service_requests_and_offer_access.sql",
];

function tableDdl(name: string): string {
  const start = bundle.indexOf(`CREATE TABLE IF NOT EXISTS public.${name} (`);
  if (start < 0) throw new Error(`table ${name} not found in the setup bundle`);
  const end = bundle.indexOf("\n);", start);
  return bundle.slice(start, end + 3);
}

const setupTables = [...bundle.matchAll(/CREATE TABLE IF NOT EXISTS public\.([a-zA-Z_][a-zA-Z0-9_]*) \(/g)].map(
  (match) => match[1]!,
);

const OWNER_ID = "11111111-1111-1111-1111-111111111111";
const CLIENT_ID = "22222222-2222-2222-2222-222222222222";
const OTHER_CLIENT_ID = "33333333-3333-3333-3333-333333333333";
const CUSTOMER_ID = "cust-a";
const OTHER_CUSTOMER_ID = "cust-b";
const PROJECT_ID = "proj-a";
const DRAFT_PROJECT_ID = "proj-a-draft";
const OTHER_PROJECT_ID = "proj-b";
const NOW = "2026-10-19T04:00:00.000Z";

/** Markers that must never appear in anything the client receives. */
const INTERNAL_MARKERS = [
  "ملاحظة داخلية", // the internal notes of the customer, the offer and the invoice
  "خطة داخلية", // the internal ai_plan of the project
  "999999", // internal_cost_minor
  "12.5", // margin_pct
  "risk-high-marker", // risk_level
];

let db: PGlite;
let before: Record<string, any>;
let after: Record<string, any>;
let functionsBefore: string[];
let functionsAfter: string[];
let policiesBefore: string[];
let policiesAfter: string[];

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

async function objectInventory(): Promise<{ functions: string[]; policies: string[] }> {
  const functions = await db.query<{ name: string }>(
    "SELECT p.proname AS name FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace WHERE n.nspname = 'public' ORDER BY p.proname",
  );
  const policies = await db.query<{ name: string }>(
    "SELECT tablename || '.' || policyname AS name FROM pg_policies WHERE schemaname = 'public' ORDER BY name",
  );
  return {
    functions: functions.rows.map((row) => row.name),
    policies: policies.rows.map((row) => row.name),
  };
}

async function seedPortalData(): Promise<void> {
  await db.query(
    `INSERT INTO public.users (id, email, name, role, status, locale, created_at, updated_at)
     VALUES ($1, 'owner@ofoq.test', 'مالك', 'OWNER', 'ACTIVE', 'ar', $4, $4),
            ($2, 'client@ofoq.test', 'عميل', 'CLIENT', 'ACTIVE', 'ar', $4, $4),
            ($3, 'other@ofoq.test', 'عميل آخر', 'CLIENT', 'ACTIVE', 'ar', $4, $4)`,
    [OWNER_ID, CLIENT_ID, OTHER_CLIENT_ID, NOW],
  );
  await db.query(
    `INSERT INTO public.customers
       (id, user_id, company_name, contact_name, email, country, city, locale, currency, status,
        internal_notes, created_at, updated_at)
     VALUES ($1, $2, 'شركة العميل', 'عميل', 'client@ofoq.test', 'IQ', 'Basra', 'ar', 'USD', 'ACTIVE',
             'ملاحظة داخلية عن العميل', $4, $4),
            ($5, $3, 'شركة أخرى', 'عميل آخر', 'other@ofoq.test', 'IQ', 'Baghdad', 'ar', 'USD', 'ACTIVE',
             'ملاحظة داخلية عن العميل الآخر', $4, $4)`,
    [CUSTOMER_ID, CLIENT_ID, OTHER_CLIENT_ID, NOW, OTHER_CUSTOMER_ID],
  );
  await db.query(
    `INSERT INTO public.projects
       (id, code, customer_id, title, title_en, status, currency, amount_total_minor, internal_cost_minor,
        margin_pct, progress, risk_level, start_date, due_date, ai_plan, created_at, updated_at)
     VALUES ($1, 'OFOQ-P-001', $2, 'مشروع العميل', 'Client project', 'IN_PROGRESS', 'USD', 50000, 999999,
             12.5, 50, 'HIGH', '2026-10-01', '2026-11-30', 'خطة داخلية', $6, $6),
            ($3, 'OFOQ-P-002', $2, 'مشروع مسودة', 'Draft project', 'DRAFT', 'USD', 0, 0, NULL, 0, NULL,
             '2026-10-01', '2026-11-30', NULL, $6, $6),
            ($4, 'OFOQ-P-003', $5, 'مشروع العميل الآخر', 'Other project', 'IN_PROGRESS', 'USD', 70000, 0,
             NULL, 10, NULL, '2026-10-01', '2026-11-30', NULL, $6, $6)`,
    [PROJECT_ID, CUSTOMER_ID, DRAFT_PROJECT_ID, OTHER_PROJECT_ID, OTHER_CUSTOMER_ID, NOW],
  );
  await db.query(
    `INSERT INTO public.project_tasks
       (id, project_id, title, title_en, status, visibility, sort_order, due_date, created_at, updated_at)
     VALUES ('task-a-visible', $1, 'مهمة ظاهرة', 'Visible task', 'DONE', 'CLIENT', 1, '2026-10-20', $2, $2),
            ('task-a-phase', $1, 'مهمة المرحلة التحضيرية', 'Phase task', 'IN_PROGRESS', 'CLIENT', 2, '2026-10-25', $2, $2),
            ('task-a-internal', $1, 'مهمة داخلية', 'Internal task', 'TODO', 'INTERNAL', 3, '2026-10-25', $2, $2),
            ('task-draft-visible', $3, 'مهمة مشروع المسودة', 'Draft task', 'TODO', 'CLIENT', 1, '2026-10-20', $2, $2),
            ('task-b-visible', $4, 'مهمة العميل الآخر', 'Other task', 'TODO', 'CLIENT', 1, '2026-10-20', $2, $2)`,
    [PROJECT_ID, NOW, DRAFT_PROJECT_ID, OTHER_PROJECT_ID],
  );
  // Offers of the client: only the published ones may ever reach the portal.
  const offers: Array<[string, string, string, string, string]> = [
    ["offer-draft", "OFQ-O-DRAFT", CUSTOMER_ID, "DRAFT", "2026-10-01T00:00:00.000Z"],
    ["offer-sent", "OFQ-O-SENT", CUSTOMER_ID, "SENT", "2026-10-02T00:00:00.000Z"],
    ["offer-approved", "OFQ-O-APPROVED", CUSTOMER_ID, "APPROVED", "2026-10-03T00:00:00.000Z"],
    ["offer-rejected", "OFQ-O-REJECTED", CUSTOMER_ID, "REJECTED", "2026-10-04T00:00:00.000Z"],
    ["offer-expired", "OFQ-O-EXPIRED", CUSTOMER_ID, "EXPIRED", "2026-10-05T00:00:00.000Z"],
    ["offer-other", "OFQ-O-OTHER", OTHER_CUSTOMER_ID, "SENT", "2026-10-06T00:00:00.000Z"],
  ];
  for (const [id, code, customerId, status, createdAt] of offers) {
    await db.query(
      `INSERT INTO public.offers
         (id, code, customer_id, status, currency, subtotal_minor, discount_minor, total_minor,
          internal_cost_minor, margin_pct, client_note, internal_note, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'USD', 10000, 0, 10000, 999999, 12.5, 'ملاحظة للعميل',
               'ملاحظة داخلية للعرض', $5, $5)`,
      [id, code, customerId, status, createdAt],
    );
  }
  await db.query(
    `INSERT INTO public.offer_items
       (id, offer_id, description_ar, description_en, quantity, unit_price_minor, billing_type, total_minor, sort_order)
     VALUES ('item-sent', 'offer-sent', 'خدمة إدارة', 'Management service', 1, 10000, 'ONE_TIME', 10000, 1)`,
  );
  await db.query(
    `INSERT INTO public.invoices
       (id, number, customer_id, currency, subtotal_minor, tax_minor, total_minor, amount_paid_minor,
        refunded_minor, status, issued_at, notes_client, internal_note, created_at, updated_at)
     VALUES ('inv-a', 'INV-A', $1, 'USD', 10000, 0, 10000, 0, 0, 'ISSUED', '2026-10-10',
             'ملاحظة للعميل', 'ملاحظة داخلية للفاتورة', $2, $2),
            ('inv-b', 'INV-B', $3, 'USD', 20000, 0, 20000, 0, 0, 'ISSUED', '2026-10-11',
             'ملاحظة للعميل الآخر', 'ملاحظة داخلية للفاتورة', $2, $2)`,
    [CUSTOMER_ID, NOW, OTHER_CUSTOMER_ID],
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
    CREATE TABLE IF NOT EXISTS auth.users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text,
      email_confirmed_at timestamptz,
      raw_user_meta_data jsonb,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );
  `);
  for (const table of setupTables) await db.exec(tableDdl(table));

  // ── the deployed state: every migration up to and including 0010 ─────
  for (const file of MIGRATION_FILES) {
    await db.exec(fs.readFileSync(path.join(process.cwd(), file), "utf8"));
  }
  await seedPortalData();

  const inventory = await objectInventory();
  functionsBefore = inventory.functions;
  policiesBefore = inventory.policies;
  before = decodeJsonRecord(
    await callAsAuthenticated<unknown>(CLIENT_ID, "SELECT public.ofoq_client_dashboard() AS result"),
  );

  // ── 0011: the migration under review ─────────────────────────────────
  await db.exec(
    fs.readFileSync(path.join(process.cwd(), "db", "migrations", "supabase", "0011_project_plans.sql"), "utf8"),
  );

  // The application writes the phase of a task and the plan versions.
  await db.query("UPDATE public.project_tasks SET phase_key = 'PREP' WHERE id IN ('task-a-phase', 'task-draft-visible')");
  await db.query(
    `INSERT INTO public.project_plans
       (id, project_id, version, status, locale, summary, phases, start_date, due_date,
        created_by_user_id, created_by_agent, approved_by_user_id, approved_at, review_note, created_at, updated_at)
     VALUES ('plan-a-approved', $1, 1, 'APPROVED', 'ar', 'خطة معتمدة',
             '[{"key":"PREP","title":"التحضير","dueDate":"2026-10-25","tasks":[{"title":"مهمة التحضير"}]}]'::jsonb,
             '2026-10-01', '2026-11-30', $3, 'project_manager', $3, $2, NULL, $2, $2),
            ('plan-a-draft', $1, 2, 'DRAFT', 'ar', 'مسودة أحدث',
             '[{"key":"PREP","title":"التحضير الجديد","tasks":[]}]'::jsonb,
             '2026-10-01', '2026-11-30', $3, 'project_manager', NULL, NULL, NULL, $2, $2),
            ('plan-draft-only', $4, 1, 'DRAFT', 'ar', 'مسودة فقط',
             '[{"key":"PREP","title":"التحضير","tasks":[]}]'::jsonb,
             '2026-10-01', '2026-11-30', $3, 'project_manager', NULL, NULL, NULL, $2, $2)`,
    [PROJECT_ID, NOW, OWNER_ID, DRAFT_PROJECT_ID],
  );

  const afterInventory = await objectInventory();
  functionsAfter = afterInventory.functions;
  policiesAfter = afterInventory.policies;
  after = decodeJsonRecord(
    await callAsAuthenticated<unknown>(CLIENT_ID, "SELECT public.ofoq_client_dashboard() AS result"),
  );
});

afterAll(async () => {
  await db?.close();
});

describe("migration 0011 on top of 0010 — compatibility", () => {
  it("applies on a database that already carries 0010", () => {
    // The whole chain (0001 → 0010 → 0011) ran on the engine in beforeAll:
    // reaching this point means the migration is compatible with the deployed
    // schema and with the hardening of 0010.
    expect(functionsAfter).toContain("ofoq_client_dashboard");
    expect(functionsAfter).toContain("ofoq_client_project_detail");
  });

  it("keeps every object 0010 created", () => {
    for (const name of functionsBefore) expect(functionsAfter).toContain(name);
    for (const name of policiesBefore) expect(policiesAfter).toContain(name);
  });

  it("does not re-grant the direct access to the offers 0010 revoked", async () => {
    const privileges = await db.query<{ direct: boolean }>(
      `SELECT has_table_privilege('authenticated', 'public.offers', 'SELECT') AS direct`,
    );
    expect(privileges.rows[0]?.direct).toBe(false);
  });

  it("returns exactly the same offers, invoices and customer as 0010 did", () => {
    expect(after.offers).toEqual(before.offers);
    expect(after.invoices).toEqual(before.invoices);
    expect(after.payments).toEqual(before.payments);
    expect(after.subscriptions).toEqual(before.subscriptions);
    expect(after.customer).toEqual(before.customer);
  });

  it("keeps the DRAFT offers and the other customer's offers hidden", () => {
    const codes = (after.offers as Record<string, any>[]).map((offer) => offer.code).sort();
    expect(codes).toEqual(["OFQ-O-APPROVED", "OFQ-O-REJECTED", "OFQ-O-SENT"]);
    expect(JSON.stringify(after)).not.toContain("OFQ-O-DRAFT");
    expect(JSON.stringify(after)).not.toContain("OFQ-O-EXPIRED");
    expect(JSON.stringify(after)).not.toContain("OFQ-O-OTHER");
  });

  it("keeps the other customer's data out of the dashboard", () => {
    const json = JSON.stringify(after);
    expect(json).not.toContain("مشروع العميل الآخر");
    expect(json).not.toContain("مهمة العميل الآخر");
    expect(json).not.toContain("INV-B");
    expect(json).not.toContain("شركة أخرى");
    const projectIds = (after.projects as Record<string, any>[]).map((project) => project.id);
    expect(projectIds).toEqual([PROJECT_ID, DRAFT_PROJECT_ID]);
  });

  it("keeps every internal column out of the dashboard", () => {
    const json = JSON.stringify(after);
    for (const marker of INTERNAL_MARKERS) expect(json).not.toContain(marker);
    const project = (after.projects as Record<string, any>[]).find((row) => row.id === PROJECT_ID)!;
    expect(project.internal_cost_minor).toBeUndefined();
    expect(project.margin_pct).toBeUndefined();
    expect(project.risk_level).toBeUndefined();
    expect(project.ai_plan).toBeUndefined();
  });

  it("adds the approved plan and hides the tasks of an unapproved plan", () => {
    const project = (after.projects as Record<string, any>[]).find((row) => row.id === PROJECT_ID)!;
    expect(project.plan).toMatchObject({ version: 1, status: "APPROVED", summary: "خطة معتمدة" });
    // The newer DRAFT version is never served.
    expect(project.plan.summary).not.toBe("مسودة أحدث");
    expect(project.plan.phases).toHaveLength(1);
    expect(project.plan.phases[0]).toMatchObject({ key: "PREP", title: "التحضير" });
    // The phase only carries the client-visible task of the project.
    expect(project.plan.phases[0].tasks).toEqual([
      expect.objectContaining({ title: "مهمة المرحلة التحضيرية", status: "IN_PROGRESS" }),
    ]);

    // The tasks of the project with an approved plan are still complete.
    const beforeTasks = (before.projects as Record<string, any>[]).find((row) => row.id === PROJECT_ID)!.tasks;
    expect(project.tasks).toEqual(beforeTasks);

    // The project whose plan was never approved keeps no task and no plan.
    const draftProject = (after.projects as Record<string, any>[]).find((row) => row.id === DRAFT_PROJECT_ID)!;
    expect(draftProject.plan).toBeNull();
    expect(draftProject.tasks).toEqual([]);
  });

  it("keeps the detail RPC owned by the customer", async () => {
    const detail = decodeJsonRecord(
      await callAsAuthenticated<unknown>(
        CLIENT_ID,
        "SELECT public.ofoq_client_project_detail($1) AS result",
        [PROJECT_ID],
      ),
    );
    expect(detail.project).toMatchObject({ id: PROJECT_ID, status: "IN_PROGRESS" });
    expect(detail.plan).toMatchObject({ status: "APPROVED" });
    expect(JSON.stringify(detail)).not.toContain("مهمة داخلية");

    await expect(
      callAsAuthenticated<unknown>(
        CLIENT_ID,
        "SELECT public.ofoq_client_project_detail($1) AS result",
        [OTHER_PROJECT_ID],
      ),
    ).rejects.toThrow(/project not found/i);
  });
});

describe("migration 0011 — what it changes in the dashboard", () => {
  function dashboardFunction(file: string): string {
    const source = fs.readFileSync(path.join(process.cwd(), file), "utf8");
    const start = source.lastIndexOf("CREATE OR REPLACE FUNCTION public.ofoq_client_dashboard(");
    if (start < 0) throw new Error(`the dashboard function is not defined in ${file}`);
    const end = source.indexOf("$function$;", start);
    return source.slice(start, end + "$function$;".length);
  }

  /**
   * A line diff (LCS) — enough to prove that 0011 only INSERTS lines into the
   * 0010 projection and never rewrites or removes one.
   */
  function diffLines(beforeLines: string[], afterLines: string[]): { removed: string[]; inserted: string[] } {
    const table: number[][] = Array.from({ length: beforeLines.length + 1 }, () => new Array<number>(afterLines.length + 1).fill(0));
    for (let i = beforeLines.length - 1; i >= 0; i -= 1) {
      for (let j = afterLines.length - 1; j >= 0; j -= 1) {
        table[i]![j] =
          beforeLines[i] === afterLines[j]
            ? table[i + 1]![j + 1]! + 1
            : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
      }
    }
    const removed: string[] = [];
    const inserted: string[] = [];
    let i = 0;
    let j = 0;
    while (i < beforeLines.length && j < afterLines.length) {
      if (beforeLines[i] === afterLines[j]) {
        i += 1;
        j += 1;
      } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
        removed.push(beforeLines[i]!);
        i += 1;
      } else {
        inserted.push(afterLines[j]!);
        j += 1;
      }
    }
    while (i < beforeLines.length) removed.push(beforeLines[i++]!);
    while (j < afterLines.length) inserted.push(afterLines[j++]!);
    return { removed, inserted };
  }

  it("only inserts the plan projection into the 0010 dashboard", () => {
    const beforeLines = dashboardFunction(
      "db/migrations/supabase/0010_harden_service_requests_and_offer_access.sql",
    ).split("\n");
    const afterLines = dashboardFunction("db/migrations/supabase/0011_project_plans.sql").split("\n");
    const { removed, inserted } = diffLines(beforeLines, afterLines);

    // Nothing of the 0010 projection is removed or rewritten: the hardening
    // (published offers only, own customer only, no internal column) is
    // carried over line by line.
    expect(removed).toEqual([]);

    // The only additions are the plan projection and the rule that keeps the
    // tasks of an unapproved plan away from the client.
    const added = inserted.join("\n");
    expect(added).toContain("'plan', (");
    expect(added).toContain("t.phase_key IS NULL");
    expect(added).toContain("approved_plan.status = 'APPROVED'");
    // The additions never carry an internal column to the client.
    for (const marker of [
      "internal_note", "internal_cost_minor", "margin_pct", "risk_level", "ai_plan", "review_note",
      "pricing_reason", "pricing_breakdown", "notes_internal",
    ]) {
      expect(added).not.toContain(marker);
    }
  });

  it("keeps the offers projection of 0010 byte for byte", () => {
    const block = (file: string): string => {
      const source = dashboardFunction(file);
      const start = source.indexOf("INTO v_offers");
      const end = source.indexOf("INTO v_invoices");
      return source.slice(start, end);
    };
    expect(block("db/migrations/supabase/0011_project_plans.sql")).toBe(
      block("db/migrations/supabase/0010_harden_service_requests_and_offer_access.sql"),
    );
  });
});
