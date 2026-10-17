/**
 * The client dashboard RPC — offer visibility, executed on PostgreSQL (PGlite).
 *
 * `ofoq_client_dashboard()` originally filtered offers with
 * `status NOT IN ('CANCELLED', 'EXPIRED')`. DRAFT offers written by the guided
 * service request were therefore returned to the client through the
 * SECURITY DEFINER RPC even after direct SELECT was revoked.
 *
 * Migration 0010 replaces the function with a positive allowlist
 * (SENT / APPROVED / REJECTED). These tests run the real migration on a real
 * PostgreSQL engine and prove:
 *
 *   1. the installed definition is the hardened one, and only the offer filter
 *      differs from the definition shipped in 0001_auth_portal.sql;
 *   2. DRAFT offers — including a DRAFT written by the real guided-request RPC —
 *      never appear in the client dashboard;
 *   3. the client still sees their own SENT / APPROVED / REJECTED offers;
 *   4. another client's SENT offer is never returned;
 *   5. projects, tasks, invoices, payments, subscriptions, campaigns, reports,
 *      files and the client profile keep the same filters and projections;
 *   6. applying 0010 does not reopen direct table/column SELECT, and only
 *      `authenticated` may execute the dashboard RPC.
 */
import fs from "node:fs";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const setupBundle = fs.readFileSync(path.join(process.cwd(), "docs", "setup", "supabase-setup.sql"), "utf8");
const authMigration = fs.readFileSync(path.join(process.cwd(), "db", "migrations", "supabase", "0001_auth_portal.sql"), "utf8");
const legacyServiceRequestMigration = fs.readFileSync(
  path.join(process.cwd(), "db", "migrations", "supabase", "0008_service_requests.sql"),
  "utf8",
);
const securityMigration = fs.readFileSync(
  path.join(process.cwd(), "db", "migrations", "supabase", "0010_harden_service_requests_and_offer_access.sql"),
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

const setupTables = [...setupBundle.matchAll(/CREATE TABLE IF NOT EXISTS public\.([a-zA-Z_][a-zA-Z0-9_]*) \(/g)].map((match) => match[1]!);

const STAFF_USER_ID = "e1c0a000-0000-0000-0000-000000000001";
const CLIENT_USER_ID = "e1c0a000-0000-0000-0000-000000000002";
const OTHER_CLIENT_USER_ID = "e1c0a000-0000-0000-0000-000000000003";
const CUSTOMER_ID = "cust-e1c0-0000-0000-0000000000aa";
const OTHER_CUSTOMER_ID = "cust-e1c0-0000-0000-0000000000bb";
const NOW = "2026-10-17T04:00:00.000Z";

let db: PGlite;

async function authenticateAs(userId: string | null): Promise<void> {
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [userId ?? ""]);
}

async function callAsAuthenticated<T>(userId: string, sql: string, params: unknown[] = []): Promise<T> {
  await authenticateAs(userId);
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
  throw new Error("Expected a JSON object returned by the dashboard RPC");
}

function ids(rows: Record<string, any>[]): string[] {
  return rows.map((row) => String(row.id)).sort();
}

/** Normalise the one intended change so the rest of the definition must match 0001. */
function withLegacyOfferFilter(sql: string): string {
  const hardenedFilter =
    /\n\s*-- Positive allowlist of published offer states\.[\s\S]*?AND o\.status IN \('SENT', 'APPROVED', 'REJECTED'\)/;
  if (!hardenedFilter.test(sql)) throw new Error("the hardened offer filter is missing");
  return sql.replace(hardenedFilter, "\n      AND o.status NOT IN ('CANCELLED', 'EXPIRED')");
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

  // Install the original portal objects and the guided-request RPC first, then
  // apply 0010 exactly as it ships.
  await db.exec(functionDdlFrom(authMigration, "ofoq_ensure_customer_profile", "0001_auth_portal.sql"));
  await db.exec(functionDdlFrom(authMigration, "ofoq_client_dashboard", "0001_auth_portal.sql"));
  await db.exec(functionDdlFrom(legacyServiceRequestMigration, "ofoq_client_service_request", "0008_service_requests.sql"));

  // Simulate the legacy direct grants the migration must keep closed.
  await db.exec("GRANT SELECT ON public.offers, public.offer_items TO authenticated");
  await db.exec("GRANT SELECT (internal_cost_minor) ON public.offers TO authenticated");
  await db.exec("GRANT SELECT (description_ar) ON public.offer_items TO authenticated");

  await db.exec(securityMigration);

  await db.query(
    `INSERT INTO public.users (id, email, name, role, status, locale, created_at, updated_at)
     VALUES ($1, 'owner@ofoq.test', 'مالك', 'OWNER', 'ACTIVE', 'ar', $4, $4),
            ($2, 'client@ofoq.test', 'عميل', 'CLIENT', 'ACTIVE', 'ar', $4, $4),
            ($3, 'other@ofoq.test', 'عميل آخر', 'CLIENT', 'ACTIVE', 'ar', $4, $4)`,
    [STAFF_USER_ID, CLIENT_USER_ID, OTHER_CLIENT_USER_ID, NOW],
  );
  await db.query(
    `INSERT INTO public.customers
       (id, user_id, company_name, contact_name, email, phone, country, city, locale, currency,
        goals, needs, internal_notes, status, created_at, updated_at)
     VALUES ($1, $2, 'شركة العميل', 'عميل', 'client@ofoq.test', '07700000000', 'IQ', 'Basra',
             'ar', 'USD', 'نمو', 'إعلانات', 'لا تُعرض للعميل', 'ACTIVE', $5, $5),
            ($3, $4, 'شركة أخرى', 'عميل آخر', 'other@ofoq.test', NULL, 'IQ', 'Baghdad',
             'ar', 'USD', NULL, NULL, NULL, 'ACTIVE', $5, $5)`,
    [CUSTOMER_ID, CLIENT_USER_ID, OTHER_CUSTOMER_ID, OTHER_CLIENT_USER_ID, NOW],
  );
  await db.query(
    `INSERT INTO public.projects (id, code, customer_id, title, title_en, status, currency, progress,
                                  start_date, due_date, created_at, updated_at)
     VALUES ('proj-own-active', 'OFOQ-P-001', $1, 'حملة نشطة', 'Active campaign', 'IN_PROGRESS', 'USD', 40,
             '2026-10-01', '2026-11-01', $3, $3),
            ('proj-own-cancelled', 'OFOQ-P-002', $1, 'حملة ملغاة', 'Cancelled campaign', 'CANCELLED', 'USD', 0,
             NULL, NULL, $3, $3),
            ('proj-other', 'OFOQ-P-003', $2, 'حملة أخرى', 'Other campaign', 'IN_PROGRESS', 'USD', 10,
             NULL, NULL, $3, $3)`,
    [CUSTOMER_ID, OTHER_CUSTOMER_ID, NOW],
  );
  await db.query(
    `INSERT INTO public.project_tasks (id, project_id, title, title_en, status, visibility, sort_order, created_at, updated_at)
     VALUES ('task-visible', 'proj-own-active', 'مهمة ظاهرة', 'Visible task', 'TODO', 'CLIENT', 1, $1, $1),
            ('task-internal', 'proj-own-active', 'مهمة داخلية', 'Internal task', 'TODO', 'INTERNAL', 2, $1, $1)`,
    [NOW],
  );
  await db.query(
    `INSERT INTO public.offers (id, code, customer_id, status, currency, subtotal_minor, total_minor,
                                internal_cost_minor, internal_note, client_note, created_at, updated_at)
     VALUES ('offer-draft', 'OFOQ-O-001', $1, 'DRAFT', 'USD', 10000, 10000, 4000, 'internal draft note', 'draft note', $3, $3),
            ('offer-sent', 'OFOQ-O-002', $1, 'SENT', 'USD', 20000, 20000, 7000, 'internal sent note', 'sent note', $3, $3),
            ('offer-approved', 'OFOQ-O-003', $1, 'APPROVED', 'USD', 30000, 30000, 9000, 'internal approved note', NULL, $3, $3),
            ('offer-rejected', 'OFOQ-O-004', $1, 'REJECTED', 'USD', 40000, 40000, 11000, 'internal rejected note', NULL, $3, $3),
            ('offer-expired', 'OFOQ-O-005', $1, 'EXPIRED', 'USD', 50000, 50000, 13000, NULL, NULL, $3, $3),
            ('offer-cancelled', 'OFOQ-O-006', $1, 'CANCELLED', 'USD', 60000, 60000, 15000, NULL, NULL, $3, $3),
            ('offer-sent-unpriced', 'OFOQ-O-007', $1, 'SENT', 'USD', NULL, NULL, 0, NULL, NULL, $3, $3),
            ('offer-other-sent', 'OFOQ-O-008', $2, 'SENT', 'USD', 70000, 70000, 19000, 'other internal note', NULL, $3, $3)`,
    [CUSTOMER_ID, OTHER_CUSTOMER_ID, NOW],
  );
  await db.query(
    `INSERT INTO public.offer_items (id, offer_id, description_ar, description_en, quantity,
                                     unit_price_minor, billing_type, months, total_minor, sort_order)
     VALUES ('item-sent-1', 'offer-sent', 'إدارة إعلانات', 'Ads management', 1, 20000, 'ONE_TIME', NULL, 20000, 1),
            ('item-other-1', 'offer-other-sent', 'إدارة أخرى', 'Other management', 1, 70000, 'ONE_TIME', NULL, 70000, 1)`,
  );
  await db.query(
    `INSERT INTO public.invoices (id, number, customer_id, currency, subtotal_minor, tax_minor, total_minor,
                                  amount_paid_minor, status, issued_at, due_at, notes_client, internal_note,
                                  created_at, updated_at)
     VALUES ('inv-own-paid', 'INV-001', $1, 'USD', 20000, 0, 20000, 20000, 'PAID', '2026-10-01', '2026-10-15',
             'ملاحظة عميل', 'ملاحظة داخلية', $3, $3),
            ('inv-own-cancelled', 'INV-002', $1, 'USD', 10000, 0, 10000, 0, 'CANCELLED', NULL, NULL,
             NULL, NULL, $3, $3),
            ('inv-other', 'INV-003', $2, 'USD', 30000, 0, 30000, 0, 'ISSUED', NULL, NULL, NULL, NULL, $3, $3)`,
    [CUSTOMER_ID, OTHER_CUSTOMER_ID, NOW],
  );
  await db.query(
    `INSERT INTO public.payments (id, invoice_id, customer_id, amount_minor, currency, method, status, paid_at, created_at, updated_at)
     VALUES ('pay-own', 'inv-own-paid', $1, 20000, 'USD', 'CARD_ONLINE', 'SUCCEEDED', '2026-10-02', $3, $3),
            ('pay-other', 'inv-other', $2, 30000, 'USD', 'MANUAL_TRANSFER', 'PENDING', NULL, $3, $3)`,
    [CUSTOMER_ID, OTHER_CUSTOMER_ID, NOW],
  );
  await db.query(
    `INSERT INTO public.subscriptions (id, customer_id, plan_name, amount_minor, currency, interval, interval_count,
                                       status, started_at, current_period_start, current_period_end, next_renewal_at,
                                       created_at, updated_at)
     VALUES ('sub-own', $1, 'باقة النمو', 50000, 'USD', 'MONTHLY', 1, 'ACTIVE', '2026-09-01', '2026-10-01',
             '2026-11-01', '2026-11-01', $3, $3),
            ('sub-other', $2, 'باقة أخرى', 30000, 'USD', 'MONTHLY', 1, 'PAST_DUE', '2026-09-01', '2026-10-01',
             '2026-11-01', NULL, $3, $3)`,
    [CUSTOMER_ID, OTHER_CUSTOMER_ID, NOW],
  );
  await db.query(
    `INSERT INTO public.campaigns (id, customer_id, platform, name, status, currency, total_budget_minor,
                                   daily_budget_minor, spent_minor, start_date, end_date, sync_status, created_at, updated_at)
     VALUES ('camp-own-active', $1, 'GOOGLE_ADS', 'حملة جوجل', 'ACTIVE', 'USD', 100000, 5000, 25000,
             '2026-10-01', '2026-10-31', 'SYNCED', $3, $3),
            ('camp-own-archived', $1, 'META_ADS', 'حملة قديمة', 'ARCHIVED', 'USD', 100000, 5000, 100000,
             '2026-01-01', '2026-02-01', 'DISABLED', $3, $3),
            ('camp-other', $2, 'TIKTOK', 'حملة أخرى', 'ACTIVE', 'USD', 50000, 2000, 0,
             NULL, NULL, 'NOT_CONNECTED', $3, $3)`,
    [CUSTOMER_ID, OTHER_CUSTOMER_ID, NOW],
  );
  await db.query(
    `INSERT INTO public.reports (id, customer_id, report_type, language, period_start, period_end,
                                 title, summary, body, status, created_at)
     VALUES ('rep-own-sent', $1, 'CAMPAIGN_DAILY', 'ar', '2026-10-01', '2026-10-07', 'تقرير مرسل',
             'ملخص مرسل', 'محتوى مرسل', 'SENT', $3),
            ('rep-own-draft', $1, 'CAMPAIGN_DAILY', 'ar', '2026-10-08', '2026-10-14', 'تقرير مسودة',
             'ملخص مسودة', 'محتوى مسودة', 'DRAFT', $3),
            ('rep-other-sent', $2, 'PROJECT', 'ar', '2026-10-01', '2026-10-07', 'تقرير آخر',
             'ملخص آخر', 'محتوى آخر', 'SENT', $3)`,
    [CUSTOMER_ID, OTHER_CUSTOMER_ID, NOW],
  );
  await db.query(
    `INSERT INTO public.files (id, customer_id, project_id, uploader_type, name, kind, mime, size_bytes,
                              storage_provider, storage_key, visibility, created_at)
     VALUES ('file-own-client', $1, 'proj-own-active', 'STAFF', 'تقرير.pdf', 'PDF', 'application/pdf', 1234,
             'local', 'files/own-client', 'CLIENT', $3),
            ('file-own-internal', $1, NULL, 'STAFF', 'داخلي.pdf', 'PDF', 'application/pdf', 123,
             'local', 'files/own-internal', 'INTERNAL', $3),
            ('file-other-client', $2, NULL, 'STAFF', 'آخر.pdf', 'PDF', 'application/pdf', 123,
             'local', 'files/other-client', 'CLIENT', $3)`,
    [CUSTOMER_ID, OTHER_CUSTOMER_ID, NOW],
  );
});

afterAll(async () => {
  await db?.close();
});

describe("migration 0010 — client dashboard offer visibility", () => {
  it("installs the hardened definition and changes only the offer filter", async () => {
    const legacy = functionDdlFrom(authMigration, "ofoq_client_dashboard", "0001_auth_portal.sql");
    const hardened = functionDdlFrom(securityMigration, "ofoq_client_dashboard", "0010");
    expect(legacy).toContain("o.status NOT IN ('CANCELLED', 'EXPIRED')");
    expect(hardened).toContain("o.status IN ('SENT', 'APPROVED', 'REJECTED')");
    expect(hardened).not.toContain("NOT IN ('CANCELLED', 'EXPIRED')");
    // Nothing else in the dashboard query may change.
    expect(withLegacyOfferFilter(hardened)).toBe(legacy);

    const installed = await db.query<{ definition: string }>(
      `SELECT pg_get_functiondef(p.oid) AS definition
         FROM pg_catalog.pg_proc AS p
         JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'ofoq_client_dashboard'`,
    );
    expect(installed.rows).toHaveLength(1);
    expect(installed.rows[0]!.definition).toContain("o.status IN ('SENT', 'APPROVED', 'REJECTED')");
    expect(installed.rows[0]!.definition).not.toContain("NOT IN ('CANCELLED', 'EXPIRED')");
    expect(installed.rows[0]!.definition).toContain("SECURITY DEFINER");
    expect(installed.rows[0]!.definition).toContain("o.customer_id = v_customer_id");
  });

  it("hides DRAFT offers from the client dashboard", async () => {
    const dashboard = decodeJsonRecord(
      await callAsAuthenticated<unknown>(CLIENT_USER_ID, "SELECT public.ofoq_client_dashboard() AS result"),
    );
    const offerIds = ids(dashboard.offers as Record<string, any>[]);
    expect(offerIds).not.toContain("offer-draft");
    expect(offerIds).toEqual(["offer-approved", "offer-rejected", "offer-sent", "offer-sent-unpriced"]);
  });

  it("hides the DRAFT offer written by the guided service request RPC", async () => {
    const created = await callAsAuthenticated<Record<string, any>>(
      CLIENT_USER_ID,
      `SELECT public.ofoq_client_service_request(
         p_request_id => $1,
         p_title_ar => $2,
         p_title_en => $3,
         p_body_ar => $4,
         p_body_en => $5,
         p_offer => $6::jsonb,
         p_contact => $7::jsonb
       ) AS result`,
      [
        "req-dashboard-draft-0001",
        "طلب خدمة",
        "Service request",
        "طلب خدمة من المساعد",
        "Service request from the assistant",
        JSON.stringify({
          pricing_breakdown: {
            serviceType: "ads",
            size: "medium",
            budgetBand: "200_500",
            budgetAmount: "500",
            budgetRange: "200-500",
            budgetSource: "typed",
            targeting: "iraq_all",
          },
        }),
        JSON.stringify({ channel: "website", value: null }),
      ],
    );
    expect(created.offerStatus).toBe("DRAFT");
    const stored = await db.query<{ status: string; customer_id: string }>(
      "SELECT status, customer_id FROM public.offers WHERE id = $1",
      [created.offerId],
    );
    expect(stored.rows[0]).toEqual({ status: "DRAFT", customer_id: CUSTOMER_ID });

    const dashboard = decodeJsonRecord(
      await callAsAuthenticated<unknown>(CLIENT_USER_ID, "SELECT public.ofoq_client_dashboard() AS result"),
    );
    const offerIds = ids(dashboard.offers as Record<string, any>[]);
    expect(offerIds).not.toContain(created.offerId);
    // The published offers remain visible next to the hidden draft.
    expect(offerIds).toEqual(["offer-approved", "offer-rejected", "offer-sent", "offer-sent-unpriced"]);
  });

  it("returns the client's own SENT, APPROVED and REJECTED offers with the safe projection", async () => {
    const dashboard = decodeJsonRecord(
      await callAsAuthenticated<unknown>(CLIENT_USER_ID, "SELECT public.ofoq_client_dashboard() AS result"),
    );
    const offers = dashboard.offers as Record<string, any>[];
    const byId = new Map(offers.map((offer) => [offer.id as string, offer]));

    expect(byId.get("offer-sent")).toMatchObject({
      code: "OFOQ-O-002",
      status: "SENT",
      currency: "USD",
      subtotalMinor: 20000,
      totalMinor: 20000,
      clientNote: "sent note",
    });
    expect(byId.get("offer-sent")!.items).toEqual([
      expect.objectContaining({
        descriptionAr: "إدارة إعلانات",
        descriptionEn: "Ads management",
        quantity: 1,
        unitPriceMinor: 20000,
        billingType: "ONE_TIME",
        totalMinor: 20000,
      }),
    ]);
    expect(byId.get("offer-approved")!.status).toBe("APPROVED");
    expect(byId.get("offer-rejected")!.status).toBe("REJECTED");
    // An unpriced `other` request is still represented as NULL, never as $0.
    expect(byId.get("offer-sent-unpriced")).toMatchObject({
      status: "SENT",
      subtotalMinor: null,
      totalMinor: null,
    });

    for (const offer of offers) {
      expect(offer).not.toHaveProperty("internalCostMinor");
      expect(offer).not.toHaveProperty("marginPct");
      expect(offer).not.toHaveProperty("internalNote");
      expect(offer).not.toHaveProperty("pricingBreakdown");
      expect(offer).not.toHaveProperty("pricingReason");
      expect(offer).not.toHaveProperty("createdByUserId");
      expect(offer).toHaveProperty("items");
    }
  });

  it("never returns another client's offers, even when they are SENT", async () => {
    const ownDashboard = decodeJsonRecord(
      await callAsAuthenticated<unknown>(CLIENT_USER_ID, "SELECT public.ofoq_client_dashboard() AS result"),
    );
    expect(ids(ownDashboard.offers as Record<string, any>[])).not.toContain("offer-other-sent");

    const otherDashboard = decodeJsonRecord(
      await callAsAuthenticated<unknown>(OTHER_CLIENT_USER_ID, "SELECT public.ofoq_client_dashboard() AS result"),
    );
    expect(otherDashboard.customer.id).toBe(OTHER_CUSTOMER_ID);
    expect(ids(otherDashboard.offers as Record<string, any>[])).toEqual(["offer-other-sent"]);
    expect((otherDashboard.offers as Record<string, any>[])[0]!.items).toEqual([
      expect.objectContaining({ descriptionAr: "إدارة أخرى" }),
    ]);
    expect(ids(otherDashboard.projects as Record<string, any>[])).toEqual(["proj-other"]);
    expect(ids(otherDashboard.invoices as Record<string, any>[])).toEqual(["inv-other"]);
    expect(ids(otherDashboard.payments as Record<string, any>[])).toEqual(["pay-other"]);
    expect(ids(otherDashboard.subscriptions as Record<string, any>[])).toEqual(["sub-other"]);
    expect(ids(otherDashboard.campaigns as Record<string, any>[])).toEqual(["camp-other"]);
    expect(ids(otherDashboard.reports as Record<string, any>[])).toEqual(["rep-other-sent"]);
    expect(ids(otherDashboard.files as Record<string, any>[])).toEqual(["file-other-client"]);
  });

  it("keeps every other dashboard section and its filters exactly as before", async () => {
    const dashboard = decodeJsonRecord(
      await callAsAuthenticated<unknown>(CLIENT_USER_ID, "SELECT public.ofoq_client_dashboard() AS result"),
    );

    expect(dashboard.customer).toMatchObject({
      id: CUSTOMER_ID,
      name: "عميل",
      companyName: "شركة العميل",
      email: "client@ofoq.test",
      phone: "07700000000",
      country: "IQ",
      city: "Basra",
      locale: "ar",
      currency: "USD",
      goals: "نمو",
      needs: "إعلانات",
    });
    expect(dashboard.customer).not.toHaveProperty("internalNotes");
    expect(dashboard.customer).not.toHaveProperty("ownerUserId");

    // Cancelled projects are excluded; only CLIENT-visible tasks are returned.
    expect(ids(dashboard.projects as Record<string, any>[])).toEqual(["proj-own-active"]);
    expect((dashboard.projects as Record<string, any>[])[0]!.tasks).toEqual([
      expect.objectContaining({ id: "task-visible", title: "مهمة ظاهرة", status: "TODO" }),
    ]);

    // Cancelled invoices are excluded and no internal columns are selected.
    expect(ids(dashboard.invoices as Record<string, any>[])).toEqual(["inv-own-paid"]);
    expect((dashboard.invoices as Record<string, any>[])[0]).toMatchObject({
      number: "INV-001",
      status: "PAID",
      notes: "ملاحظة عميل",
    });
    expect((dashboard.invoices as Record<string, any>[])[0]).not.toHaveProperty("internalNote");

    expect(ids(dashboard.payments as Record<string, any>[])).toEqual(["pay-own"]);
    expect(ids(dashboard.subscriptions as Record<string, any>[])).toEqual(["sub-own"]);
    // Archived campaigns are excluded.
    expect(ids(dashboard.campaigns as Record<string, any>[])).toEqual(["camp-own-active"]);
    // Only SENT reports are returned.
    expect(ids(dashboard.reports as Record<string, any>[])).toEqual(["rep-own-sent"]);
    // Only CLIENT-visible files are returned.
    expect(ids(dashboard.files as Record<string, any>[])).toEqual(["file-own-client"]);
  });

  it("does not reopen direct reads and keeps execution limited to authenticated users", async () => {
    const privileges = await db.query<{
      offers: boolean;
      items: boolean;
      internalCost: boolean;
      itemDescription: boolean;
      verificationTable: boolean;
    }>(
      `SELECT has_table_privilege('authenticated', 'public.offers', 'SELECT') AS offers,
              has_table_privilege('authenticated', 'public.offer_items', 'SELECT') AS items,
              has_column_privilege('authenticated', 'public.offers', 'internal_cost_minor', 'SELECT') AS "internalCost",
              has_column_privilege('authenticated', 'public.offer_items', 'description_ar', 'SELECT') AS "itemDescription",
              has_table_privilege('authenticated', 'public.ofoq_service_request_price_verifications', 'SELECT') AS "verificationTable"`,
    );
    expect(privileges.rows[0]).toEqual({
      offers: false,
      items: false,
      internalCost: false,
      itemDescription: false,
      verificationTable: false,
    });

    await authenticateAs(CLIENT_USER_ID);
    await db.query("SET ROLE authenticated");
    try {
      await expect(db.query("SELECT internal_cost_minor FROM public.offers LIMIT 1")).rejects.toThrow(/permission denied/i);
      await expect(db.query("SELECT description_ar FROM public.offer_items LIMIT 1")).rejects.toThrow(/permission denied/i);
      await expect(db.query("SELECT * FROM public.ofoq_service_request_price_verifications LIMIT 1")).rejects.toThrow(
        /permission denied/i,
      );
    } finally {
      await db.query("RESET ROLE");
    }

    const execute = await db.query<{ authenticated: boolean; anon: boolean }>(
      `SELECT has_function_privilege('authenticated', 'public.ofoq_client_dashboard()', 'EXECUTE') AS authenticated,
              has_function_privilege('anon', 'public.ofoq_client_dashboard()', 'EXECUTE') AS anon`,
    );
    expect(execute.rows[0]).toEqual({ authenticated: true, anon: false });
  });
});
