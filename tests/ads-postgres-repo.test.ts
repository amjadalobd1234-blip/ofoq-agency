/**
 * Ads repository SQL on PostgreSQL (PGlite).
 *
 * `/api/ads*` uses the shared driver (`?` placeholders rewritten to `$1…` by
 * PostgresDriver). This suite runs the real repository against a real
 * PostgreSQL engine so the staff APIs are not SQLite-only.
 */
import fs from "node:fs";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { toPositional } from "@/lib/db/postgres";
import type { DbDriver, SqlValue } from "@/lib/db/types";
import {
  createAdPlan,
  listApprovedAdPlansForCustomer,
  listLatestAdPlans,
} from "@/lib/repositories/ads.repo";

const setupBundle = fs.readFileSync(path.join(process.cwd(), "docs", "setup", "supabase-setup.sql"), "utf8");

function tableDdl(name: string): string {
  const start = setupBundle.indexOf(`CREATE TABLE IF NOT EXISTS public.${name} (`);
  if (start < 0) throw new Error(`table ${name} not found in the setup bundle`);
  const end = setupBundle.indexOf("\n);", start);
  return setupBundle.slice(start, end + 3);
}

const NOW = "2026-10-22T04:00:00.000Z";
const OWNER_ID = "pg-ads-owner";
const CLIENT_ID = "pg-ads-client";
const CUSTOMER_ID = "pg-ads-customer";
const OTHER_CUSTOMER_ID = "pg-ads-other-customer";

function pgliteDriver(db: PGlite): DbDriver {
  return {
    dialect: "postgres",
    target: "pglite",
    async query<T>(sql: string, params: SqlValue[] = []): Promise<T[]> {
      const { text, values } = toPositional(sql, params);
      const result = await db.query(text, values);
      return result.rows as T[];
    },
    async get<T>(sql: string, params: SqlValue[] = []): Promise<T | undefined> {
      const rows = await this.query<T>(sql, params);
      return rows[0];
    },
    async run(sql: string, params: SqlValue[] = []) {
      const { text, values } = toPositional(sql, params);
      const result = await db.query(text, values);
      return { changes: result.affectedRows ?? result.rows.length };
    },
    async exec(sql: string) {
      await db.exec(sql);
    },
    async transaction<T>(fn: (tx: DbDriver) => Promise<T>): Promise<T> {
      return fn(this);
    },
    async close() {
      /* the suite closes the engine */
    },
  };
}

let db: PGlite;
let driver: DbDriver;

beforeAll(async () => {
  db = new PGlite();
  for (const table of ["users", "customers", "projects", "ad_plans", "ad_plan_results"]) {
    await db.exec(tableDdl(table));
  }
  driver = pgliteDriver(db);
  await db.query(
    `INSERT INTO public.users (id, email, name, role, status, locale, created_at, updated_at)
     VALUES ($1, 'owner@ofoq.test', 'مالك', 'OWNER', 'ACTIVE', 'ar', $3, $3),
            ($2, 'client@ofoq.test', 'عميل', 'CLIENT', 'ACTIVE', 'ar', $3, $3)`,
    [OWNER_ID, CLIENT_ID, NOW],
  );
  await db.query(
    `INSERT INTO public.customers
       (id, user_id, company_name, contact_name, email, country, city, locale, currency, status, created_at, updated_at)
     VALUES ($1, $2, 'شركة', 'عميل', 'client@ofoq.test', 'IQ', 'Basra', 'ar', 'USD', 'ACTIVE', $3, $3),
            ($4, $2, 'أخرى', 'آخر', 'other@ofoq.test', 'IQ', 'Baghdad', 'ar', 'USD', 'ACTIVE', $3, $3)`,
    [CUSTOMER_ID, CLIENT_ID, NOW, OTHER_CUSTOMER_ID],
  );
});

afterAll(async () => {
  await db?.close();
});

describe("ads repository on PostgreSQL", () => {
  it("creates a plan and lists only the customer's APPROVED copy", async () => {
    await createAdPlan(
      {
        id: "ad-draft",
        code: "OFQ-AD-2026-0001",
        customer_id: CUSTOMER_ID,
        family_key: CUSTOMER_ID,
        version: 1,
        status: "DRAFT",
        body: '{"objective":"MESSAGES"}',
        internal_note: "ملاحظة داخلية",
        created_by_user_id: OWNER_ID,
      },
      driver,
    );
    await createAdPlan(
      {
        id: "ad-approved",
        code: "OFQ-AD-2026-0001",
        customer_id: CUSTOMER_ID,
        family_key: CUSTOMER_ID,
        version: 2,
        status: "APPROVED",
        body: '{"objective":"SALES","totalBudgetMinor":15000}',
        internal_note: "لا تظهر",
        created_by_user_id: OWNER_ID,
        approved_by_user_id: OWNER_ID,
        approved_at: NOW,
      },
      driver,
    );
    await createAdPlan(
      {
        id: "ad-other",
        code: "OFQ-AD-2026-0002",
        customer_id: OTHER_CUSTOMER_ID,
        family_key: OTHER_CUSTOMER_ID,
        version: 1,
        status: "APPROVED",
        body: '{"objective":"TRAFFIC"}',
        created_by_user_id: OWNER_ID,
        approved_at: NOW,
      },
      driver,
    );

    const approved = await listApprovedAdPlansForCustomer(CUSTOMER_ID, driver);
    expect(approved.map((row) => row.id)).toEqual(["ad-approved"]);
    expect(approved[0]!.status).toBe("APPROVED");
    expect(approved.map((row) => row.id)).not.toContain("ad-other");
    expect(approved.map((row) => row.id)).not.toContain("ad-draft");

    const latest = await listLatestAdPlans({ customerId: CUSTOMER_ID }, driver);
    expect(latest.map((row) => row.id)).toEqual(["ad-approved"]);
  });
});
