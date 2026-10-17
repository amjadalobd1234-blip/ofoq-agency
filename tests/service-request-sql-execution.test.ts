/**
 * The database half of a completed guided request — executed for real.
 *
 * The hardened `ofoq_client_service_request()` (migration 0010) is run on a
 * real PostgreSQL server (PGlite) against the setup bundle's table DDL. It proves, on
 * the persistence path itself and not on display text:
 *
 *   1. the `offers` row is written with status DRAFT and an OFOQ-<year>-NNN code,
 *      and the schema's CHECK really does refuse REQUESTED today;
 *   2. the /admin/alerts row is IMPORTANT / NEW_REQUEST, titled
 *      «طلب خدمة جديد #<order>» — never the HUMAN_REQUEST / URGENT shape of the
 *      escalation RPC, which is not involved at all;
 *   3. a WhatsApp request carries the channel, the number exactly as typed and
 *      the wa.me link in the alert body and meta;
 *   4. a retry with the same request id returns the saved rows (no second order);
 *   5. a signed-out call is refused (28000) and writes nothing.
 */
import fs from "node:fs";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { plainText } from "./helpers/bidi";

import {
  SERVICE_REQUEST_OFFER_STATUS,
  prepareServiceRequestOffer,
  supabaseServiceRequestStore,
  type ServiceRequestSubmissionInput,
} from "../src/lib/services/service-requests.service";

const setupBundle = fs.readFileSync(path.join(process.cwd(), "docs", "setup", "supabase-setup.sql"), "utf8");
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

function functionDdl(name: string): string {
  return functionDdlFrom(setupBundle, name, "the setup bundle");
}

const setupTables = [...setupBundle.matchAll(/CREATE TABLE IF NOT EXISTS public\.([a-zA-Z_][a-zA-Z0-9_]*) \(/g)].map((match) => match[1]!);

const STAFF_USER_ID = "d9352a7b-0000-0000-0000-000000000001";
const CLIENT_USER_ID = "d9352a7b-0000-0000-0000-000000000002";
const SECOND_CLIENT_USER_ID = "d9352a7b-0000-0000-0000-000000000003";
const CUSTOMER_ID = "cust-0000-0000-0000-0000000000aa";
const SECOND_CUSTOMER_ID = "cust-0000-0000-0000-0000000000bb";
const CONVERSATION_ID = "conv-0000-0000-0000-0000000000aa";
const NOW = "2026-10-12T04:00:00.000Z";
const TYPED_NUMBER = "07707048629";

let db: PGlite;

async function authenticateAs(userId: string | null): Promise<void> {
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [userId ?? ""]);
}

/** The route's client, pointed at PGlite: `rpc(name, args)` → SELECT name(args). */
function pgliteRpcClient() {
  return {
    async rpc(functionName: string, args: Record<string, unknown> = {}) {
      const names = Object.keys(args);
      const placeholders = names.map((name, index) => {
        const value = args[name];
        const isJson = value !== null && typeof value === "object";
        return `${name} => $${index + 1}${isJson ? "::jsonb" : ""}`;
      });
      const params = names.map((name) => {
        const value = args[name];
        return value !== null && typeof value === "object" ? JSON.stringify(value) : value;
      });
      try {
        const result = await db.query<{ result: unknown }>(`SELECT public.${functionName}(${placeholders.join(", ")}) AS result`, params);
        return { data: result.rows[0]?.result ?? null, error: null };
      } catch (error) {
        const failure = error as { code?: string; message?: string; detail?: string; hint?: string };
        return { data: null, error: { code: String(failure.code ?? ""), message: failure.message ?? "", details: failure.detail ?? null, hint: failure.hint ?? null } };
      }
    },
  };
}

function decodeJsonRecord(value: unknown): Record<string, any> {
  if (typeof value === "string") return JSON.parse(value) as Record<string, any>;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, any>;
  throw new Error("Expected a JSON object returned by the dashboard RPC");
}

async function callAsAuthenticated<T>(userId: string, sql: string): Promise<T> {
  await authenticateAs(userId);
  await db.query("SET ROLE authenticated");
  try {
    const result = await db.query<{ result: T }>(sql);
    return result.rows[0]!.result;
  } finally {
    await db.query("RESET ROLE");
  }
}

function whatsappRequest(overrides: Partial<ServiceRequestSubmissionInput> = {}): ServiceRequestSubmissionInput {
  return {
    requestId: "req-whatsapp-0001",
    answers: {
      type: "ads",
      size: "medium",
      budget: "200_500",
      budgetRange: "200-500",
      budgetAmount: "500",
      targeting: "iraq_all",
      contact: "whatsapp",
      phone: TYPED_NUMBER,
    },
    contact: { channel: "whatsapp", value: TYPED_NUMBER },
    clientEmail: "alobdali8@gmail.com",
    customerName: "امجد",
    locale: "ar",
    conversationId: CONVERSATION_ID,
    ...overrides,
  };
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
  await db.exec(functionDdl("ofoq_ensure_customer_profile"));
  await db.exec(functionDdlFrom(legacyServiceRequestMigration, "ofoq_client_service_request", "migration 0008"));
  // Simulate the old broad table grant and prove 0010 removes it.
  await db.exec("GRANT SELECT ON public.offers, public.offer_items TO authenticated");
  await db.exec("GRANT SELECT (internal_cost_minor) ON public.offers TO authenticated");
  await db.exec("GRANT SELECT (description_ar) ON public.offer_items TO authenticated");
  await db.exec(securityMigration);
  await db.exec(functionDdl("ofoq_is_staff"));
  await db.exec(functionDdl("ofoq_client_dashboard"));
  await db.exec(functionDdl("ofoq_admin_dashboard"));
  await db.exec("GRANT EXECUTE ON FUNCTION public.ofoq_client_dashboard() TO authenticated");
  await db.exec("GRANT EXECUTE ON FUNCTION public.ofoq_admin_dashboard() TO authenticated");

  await db.query(
    `INSERT INTO public.users (id, email, name, role, status, locale, created_at, updated_at)
     VALUES ($1, 'owner@ofoq.test', 'أمجد', 'OWNER', 'ACTIVE', 'ar', $4, $4),
            ($2, 'client@ofoq.test', 'عميل', 'CLIENT', 'ACTIVE', 'ar', $4, $4),
            ($3, 'client2@ofoq.test', 'عميلة ثانية', 'CLIENT', 'ACTIVE', 'ar', $4, $4)`,
    [STAFF_USER_ID, CLIENT_USER_ID, SECOND_CLIENT_USER_ID, NOW],
  );
  await db.query(
    `INSERT INTO public.customers (id, user_id, contact_name, email, status, created_at, updated_at)
     VALUES ($1, $2, 'امجد', 'alobdali8@gmail.com', 'ACTIVE', $3, $3),
            ($4, $5, 'عميلة ثانية', 'client2@ofoq.test', 'ACTIVE', $3, $3)`,
    [CUSTOMER_ID, CLIENT_USER_ID, NOW, SECOND_CUSTOMER_ID, SECOND_CLIENT_USER_ID],
  );
  await db.query(
    `INSERT INTO public.conversations (id, customer_id, channel, subject, status, is_demo, created_at, updated_at)
     VALUES ($1, $2, 'WEB', 'طلب جديد', 'OPEN', 0, $3, $3)`,
    [CONVERSATION_ID, CUSTOMER_ID, NOW],
  );
});

afterAll(async () => {
  await db?.close();
});

describe("ofoq_client_service_request on PostgreSQL", () => {
  it("is the shipped function, and the escalation RPC is not part of the request path", async () => {
    const signature = await db.query<{ args: string }>(
      "SELECT pg_get_function_arguments(p.oid) AS args FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'ofoq_client_service_request'",
    );
    expect(signature.rows[0]?.args).toContain("p_request_id text");
    expect(signature.rows[0]?.args).toContain("p_meta jsonb");
    // The migration never defines or calls the human-handoff RPC.
    const migration = securityMigration;
    expect(migration).not.toMatch(/PERFORM\s+public\.ofoq_client_escalate|SELECT\s+public\.ofoq_client_escalate/);
    expect(migration).not.toContain("'HUMAN_REQUEST'");
    expect(migration).not.toContain("'URGENT'");
    expect(migration).toContain("v_total_minor := NULL");
    expect(migration).toContain("REVOKE ALL PRIVILEGES ON TABLE public.offers, public.offer_items");
  });

  it("saves a WhatsApp request: DRAFT offer, IMPORTANT/NEW_REQUEST alert, number as typed and wa.me link", async () => {
    await authenticateAs(CLIENT_USER_ID);
    const store = supabaseServiceRequestStore(pgliteRpcClient());
    const record = prepareServiceRequestOffer(whatsappRequest());

    const saved = await store.save(record);

    expect(saved.created).toBe(true);
    expect(saved.orderCode).toMatch(/^OFOQ-\d{4}-001$/);
    expect(saved.offerStatus).toBe("DRAFT");
    expect(saved.priceVerified).toBe(true);
    expect(saved.price).toEqual({ min: 390, max: 1950, mid: 1170 });
    expect(saved.alert).toEqual({ category: "NEW_REQUEST", severity: "IMPORTANT" });

    const offer = await db.query<{ status: string; code: string; customer_id: string; created_by_user_id: string | null; pricing_breakdown: string; total_minor: string | number }>(
      "SELECT status, code, customer_id, created_by_user_id, pricing_breakdown, total_minor FROM public.offers WHERE id = $1",
      [saved.offerId],
    );
    expect(offer.rows[0]).toMatchObject({
      status: SERVICE_REQUEST_OFFER_STATUS,
      code: saved.orderCode,
      customer_id: CUSTOMER_ID,
      created_by_user_id: null,
    });
    const verification = await db.query<{ offer_id: string; user_id: string }>(
      "SELECT offer_id, user_id FROM public.ofoq_service_request_price_verifications WHERE offer_id = $1",
      [saved.offerId],
    );
    expect(verification.rows).toEqual([{ offer_id: saved.offerId, user_id: CLIENT_USER_ID }]);
    const breakdown = JSON.parse(offer.rows[0]!.pricing_breakdown) as Record<string, unknown>;
    expect(breakdown).toMatchObject({
      orderCode: saved.orderCode,
      status: "DRAFT",
      source: "guided_service_request",
      budgetRange: "200-500",
      budgetAmount: 500,
      budgetSource: "typed",
    });

    const alert = await db.query<{
      severity: string;
      category: string;
      title_ar: string;
      title_en: string;
      body_ar: string;
      entity_type: string;
      entity_id: string;
      customer_id: string;
      target_role: string;
      status: string;
      dedupe_key: string;
      meta: string;
    }>("SELECT * FROM public.alerts WHERE id = $1", [saved.alertId]);
    const row = alert.rows[0]!;
    expect(row).toMatchObject({
      severity: "IMPORTANT",
      category: "NEW_REQUEST",
      title_ar: `طلب خدمة جديد #${saved.orderCode}`,
      title_en: `New service request #${saved.orderCode}`,
      // The conversation belongs to the client, so the admin page can show it.
      entity_type: "conversation",
      entity_id: CONVERSATION_ID,
      customer_id: CUSTOMER_ID,
      target_role: "ANY_STAFF",
      status: "NEW",
      dedupe_key: `service-request:${CLIENT_USER_ID}:req-whatsapp-0001`,
    });
    expect(row.body_ar.split("\n")[0]).toBe(`رقم الطلب: ${saved.orderCode}`);
    expect(row.body_ar).toContain("قناة التواصل: واتساب");
    expect(row.body_ar).toContain(`رقم العميل: ${TYPED_NUMBER}`);
    expect(row.body_ar).toContain("رابط واتساب: https://wa.me/9647707048629");
    expect(plainText(row.body_ar)).toContain("الميزانية: 200-500$");
    expect(row.body_ar).not.toContain("500 من 200");

    const meta = JSON.parse(row.meta) as Record<string, any>;
    expect(meta.contact).toEqual({ channel: "whatsapp", value: TYPED_NUMBER, whatsappNumber: "9647707048629", whatsappLink: "https://wa.me/9647707048629" });
    expect(meta.whatsapp).toEqual({ channel: "واتساب", number: TYPED_NUMBER, international: "9647707048629", link: "https://wa.me/9647707048629" });
    expect(meta).toMatchObject({ orderCode: saved.orderCode, offerId: saved.offerId, offerStatus: "DRAFT", source: "guided_service_request" });
    expect({ ...meta.budget, display: plainText(String(meta.budget.display)) }).toEqual({
      band: "200_500",
      range: "200-500",
      amount: 500,
      source: "typed",
      display: "200-500$",
    });

    // The team is notified and the trail is written; the customer's phone is now known.
    const notifications = await db.query<{ channel: string; status: string; user_id: string }>(
      "SELECT channel, status, user_id FROM public.notifications WHERE alert_id = $1 ORDER BY channel",
      [saved.alertId],
    );
    expect(notifications.rows).toEqual([
      { channel: "EMAIL", status: "QUEUED", user_id: STAFF_USER_ID },
      { channel: "IN_APP", status: "SENT", user_id: STAFF_USER_ID },
    ]);
    const activity = await db.query<{ action: string; entity_id: string }>(
      "SELECT action, entity_id FROM public.activities WHERE entity_type = 'service_request'",
    );
    expect(activity.rows).toEqual([{ action: "service_request.submitted", entity_id: saved.offerId }]);
    const phone = await db.query<{ phone: string | null }>("SELECT phone FROM public.customers WHERE id = $1", [CUSTOMER_ID]);
    expect(phone.rows[0]?.phone).toBe(TYPED_NUMBER);
    // The conversation is NOT flipped to PENDING: this is a request, not a handoff.
    const conversation = await db.query<{ status: string }>("SELECT status FROM public.conversations WHERE id = $1", [CONVERSATION_ID]);
    expect(conversation.rows[0]?.status).toBe("OPEN");
  });

  it("returns the saved rows again for the same request id instead of a second order", async () => {
    await authenticateAs(CLIENT_USER_ID);
    const store = supabaseServiceRequestStore(pgliteRpcClient());
    const retry = await store.save(prepareServiceRequestOffer(whatsappRequest()));

    expect(retry.created).toBe(false);
    expect(retry.orderCode).toMatch(/^OFOQ-\d{4}-001$/);
    expect(retry.offerStatus).toBe("DRAFT");
    expect(retry.priceVerified).toBe(true);
    expect(retry.price).toEqual({ min: 390, max: 1950, mid: 1170 });
    const offers = await db.query<{ count: string }>("SELECT count(*)::text AS count FROM public.offers");
    expect(Number(offers.rows[0]!.count)).toBe(1);
  });

  it("does not trust a forged calculationVersion marker on a legacy idempotency row", async () => {
    await db.query(
      `INSERT INTO public.offers
         (id, code, customer_id, status, currency, subtotal_minor, total_minor, pricing_breakdown,
          created_by_user_id, created_at, updated_at)
       VALUES ('legacy-untrusted-offer', 'OFOQ-2026-LEGACY', $1, 'DRAFT', 'USD', 99900, 99900, $2, NULL, $3, $3)`,
      [
        CUSTOMER_ID,
        JSON.stringify({
          calculationVersion: "service-request-db-v1",
          price: { min: 999, max: 999, mid: 999, currency: "USD" },
        }),
        NOW,
      ],
    );
    await db.query(
      `INSERT INTO public.alerts
         (id, severity, category, title_ar, title_en, body_ar, body_en, entity_type, entity_id,
          customer_id, target_role, status, dedupe_key, meta, is_demo, created_at, updated_at)
       VALUES ('legacy-untrusted-alert', 'IMPORTANT', 'NEW_REQUEST', 'قديم', 'Legacy', 'قديم', 'Legacy',
          'service_request', 'legacy-untrusted-offer', $1, 'ANY_STAFF', 'NEW', $2, $3, 0, $4, $4)`,
      [
        CUSTOMER_ID,
        "service-request:req-legacy-forged-0001",
        JSON.stringify({ offerId: "legacy-untrusted-offer", orderCode: "OFOQ-2026-LEGACY" }),
        NOW,
      ],
    );

    await authenticateAs(CLIENT_USER_ID);
    const retry = await supabaseServiceRequestStore(pgliteRpcClient()).save(
      prepareServiceRequestOffer(whatsappRequest({ requestId: "req-legacy-forged-0001" })),
    );
    expect(retry.created).toBe(false);
    expect(retry.orderCode).toBe("OFOQ-2026-LEGACY");
    expect(retry.priceVerified).toBe(false);
    expect(retry.price).toEqual({ min: null, max: null, mid: null });
  });

  it("does not return a pre-migration caller-supplied total as a verified retry price", async () => {
    await authenticateAs(CLIENT_USER_ID);
    const first = await db.query<{ id: string }>(
      "SELECT id FROM public.offers WHERE code ~ '^OFOQ-[0-9]{4}-[0-9]{3}$' ORDER BY code LIMIT 1",
    );
    expect(first.rows).toHaveLength(1);
    await db.query(
      `UPDATE public.offers
       SET total_minor = 1, subtotal_minor = 1,
           pricing_breakdown = (pricing_breakdown::jsonb - 'calculationVersion')::text
       WHERE id = $1`,
      [first.rows[0]!.id],
    );
    const retry = await supabaseServiceRequestStore(pgliteRpcClient()).save(prepareServiceRequestOffer(whatsappRequest()));
    expect(retry.created).toBe(false);
    expect(retry.priceVerified).toBe(false);
    expect(retry.price).toEqual({ min: null, max: null, mid: null });
    const persisted = await db.query<{ total_minor: string | number; subtotal_minor: string | number }>(
      "SELECT total_minor, subtotal_minor FROM public.offers WHERE id = $1", [first.rows[0]!.id],
    );
    // No silent backfill/update: historical rows are left for owner review.
    expect(Number(persisted.rows[0]!.total_minor)).toBe(1);
    expect(Number(persisted.rows[0]!.subtotal_minor)).toBe(1);
  });

  it("issues the next order code for a new request and keeps the email channel's address", async () => {
    await authenticateAs(CLIENT_USER_ID);
    const store = supabaseServiceRequestStore(pgliteRpcClient());
    const saved = await store.save(
      prepareServiceRequestOffer(
        whatsappRequest({
          requestId: "req-email-0002",
          answers: { type: "design", size: "small", budget: "under_200", targeting: "baghdad", contact: "email" },
          contact: { channel: "email", value: "alobdali8@gmail.com" },
          conversationId: null,
        }),
      ),
    );
    expect(saved.orderCode).toMatch(/^OFOQ-\d{4}-002$/);
    const alert = await db.query<{ body_ar: string; entity_type: string; entity_id: string; meta: string }>(
      "SELECT body_ar, entity_type, entity_id, meta FROM public.alerts WHERE id = $1",
      [saved.alertId],
    );
    expect(alert.rows[0]).toMatchObject({ entity_type: "service_request", entity_id: saved.offerId });
    expect(alert.rows[0]!.body_ar).toContain("قناة التواصل: البريد الإلكتروني — alobdali8@gmail.com");
    expect(alert.rows[0]!.body_ar).toContain("الميزانية: أقل من 200$");
    expect((JSON.parse(alert.rows[0]!.meta) as { whatsapp: unknown }).whatsapp).toBeNull();
  });

  it("recomputes a forged direct RPC price and ignores caller-supplied status, currency, notes and staff metadata", async () => {
    await authenticateAs(CLIENT_USER_ID);
    const client = pgliteRpcClient();
    const response = await client.rpc("ofoq_client_service_request", {
      p_request_id: "req-forged-0003",
      p_title_ar: "FORGED TITLE",
      p_title_en: "FORGED TITLE",
      p_body_ar: "FORGED BODY",
      p_body_en: "FORGED BODY",
      p_offer: {
        status: "SENT",
        currency: "IQD",
        total_minor: 1,
        subtotal_minor: 1,
        internal_cost_minor: 1,
        created_by_agent: "spoofed-agent",
        created_by_user_id: SECOND_CLIENT_USER_ID,
        pricing_reason: "forged",
        internal_note: "internal leak",
        client_note: "fake client note",
        pricing_breakdown: {
          serviceType: "ads",
          size: "medium",
          budgetBand: "200_500",
          budgetAmount: 500,
          budgetRange: "200-500",
          budgetSource: "typed",
          targeting: "iraq_all",
          price: { min: 0, max: 0, mid: 0 },
          expectedResults: { impressions: [0, 0] },
        },
      },
      p_contact: {
        channel: "whatsapp",
        value: TYPED_NUMBER,
        whatsappNumber: "00000000000",
        whatsappLink: "https://example.invalid/attacker",
      },
      p_meta: { staff: [{ email: "staff-secret@example.test" }], price: { min: 0, max: 0 } },
      p_conversation_id: CONVERSATION_ID,
      p_locale: "ar",
    });

    expect(response.error).toBeNull();
    const result = response.data as Record<string, any>;
    expect(result).toMatchObject({ offerStatus: "DRAFT", created: true, priceVerified: true, price: { min: 390, max: 1950, mid: 1170 } });
    expect(result).not.toHaveProperty("staff");
    const offer = await db.query<{
      status: string; currency: string; total_minor: string | number; subtotal_minor: string | number;
      internal_cost_minor: string | number; pricing_reason: string; pricing_breakdown: string;
      created_by_agent: string; created_by_user_id: string | null; internal_note: string; client_note: string;
    }>("SELECT status, currency, total_minor, subtotal_minor, internal_cost_minor, pricing_reason, pricing_breakdown, created_by_agent, created_by_user_id, internal_note, client_note FROM public.offers WHERE id = $1", [result.offerId]);
    const row = offer.rows[0]!;
    expect(row.status).toBe("DRAFT");
    expect(row.currency).toBe("USD");
    expect(Number(row.total_minor)).toBe(117000);
    expect(Number(row.subtotal_minor)).toBe(117000);
    expect(Number(row.internal_cost_minor)).toBe(0);
    expect(row.created_by_agent).toBe("pricing-agent");
    expect(row.created_by_user_id).toBeNull();
    expect(row.pricing_reason).toBe("service_request:ads:200_500:iraq_all");
    expect(row.internal_note).toContain(TYPED_NUMBER);
    expect(row.internal_note).not.toContain("internal leak");
    expect(row.client_note).not.toContain("fake client note");
    const breakdown = JSON.parse(row.pricing_breakdown) as Record<string, any>;
    expect(breakdown).toMatchObject({
      calculationVersion: "service-request-db-v1",
      price: { min: 390, max: 1950, mid: 1170, currency: "USD" },
    });

    const alert = await db.query<{ title_ar: string; body_ar: string; meta: string }>("SELECT title_ar, body_ar, meta FROM public.alerts WHERE id = $1", [result.alertId]);
    expect(alert.rows[0]!.title_ar).not.toContain("FORGED");
    expect(alert.rows[0]!.body_ar).not.toContain("FORGED");
    expect(alert.rows[0]!.body_ar).toContain("رابط واتساب: https://wa.me/9647707048629");
    expect(alert.rows[0]!.meta).not.toContain("staff-secret@example.test");
    expect(alert.rows[0]!.meta).not.toContain("\"price\": {\"min\": 0");
  });

  it("persists `other` with NULL amounts instead of a fake $0 offer", async () => {
    await authenticateAs(CLIENT_USER_ID);
    const record = prepareServiceRequestOffer(whatsappRequest({
      requestId: "req-other-0004",
      answers: { type: "other", size: "medium", budget: "200_500", budgetRange: "200-500", budgetAmount: "500", targeting: "iraq_all", contact: "whatsapp", phone: TYPED_NUMBER },
    }));
    expect(record.price).toEqual({ min: null, max: null, mid: null });
    expect(record.offer.total_minor).toBeNull();
    const saved = await supabaseServiceRequestStore(pgliteRpcClient()).save(record);
    expect(saved.priceVerified).toBe(true);
    expect(saved.price).toEqual({ min: null, max: null, mid: null });
    const row = await db.query<{ subtotal_minor: string | number | null; total_minor: string | number | null; breakdown: string }>(
      "SELECT subtotal_minor, total_minor, pricing_breakdown AS breakdown FROM public.offers WHERE id = $1", [saved.offerId],
    );
    expect(row.rows[0]!.subtotal_minor).toBeNull();
    expect(row.rows[0]!.total_minor).toBeNull();
    expect(JSON.parse(row.rows[0]!.breakdown)).toMatchObject({ price: { min: null, max: null, mid: null, currency: "USD" } });
    const alert = await db.query<{ body_ar: string }>("SELECT body_ar FROM public.alerts WHERE id = $1", [saved.alertId]);
    expect(alert.rows[0]!.body_ar).toContain("لا يوجد سعر محدد");
    expect(alert.rows[0]!.body_ar).not.toContain("$0");
  });

  it("keeps database prices and ad projections identical to the existing pricing-agent formulas", async () => {
    const cases: Array<{
      type: string; size: string; budget: string; targeting: string; budgetRange?: string; budgetAmount?: string;
    }> = [
      { type: "design", size: "small", budget: "under_200", targeting: "baghdad" },
      { type: "ads", size: "medium", budget: "200_500", budgetRange: "200-500", budgetAmount: "500", targeting: "basra" },
      { type: "social", size: "large", budget: "500_1500", targeting: "three_cities" },
      { type: "content", size: "medium", budget: "over_1500", targeting: "gulf" },
      { type: "seo", size: "large", budget: "over_1500", budgetRange: "1501-2500", budgetAmount: "2500", targeting: "arabic_global" },
      { type: "other", size: "small", budget: "200_500", targeting: "iraq_all" },
    ] as const;

    await authenticateAs(CLIENT_USER_ID);
    const store = supabaseServiceRequestStore(pgliteRpcClient());
    for (const [index, selection] of cases.entries()) {
      const answers: ServiceRequestSubmissionInput["answers"] = {
        type: selection.type,
        size: selection.size,
        budget: selection.budget,
        ...(selection.budgetRange ? { budgetRange: selection.budgetRange } : {}),
        ...(selection.budgetAmount ? { budgetAmount: selection.budgetAmount } : {}),
        targeting: selection.targeting,
        contact: "whatsapp",
        phone: TYPED_NUMBER,
      };
      const record = prepareServiceRequestOffer(whatsappRequest({
        requestId: `req-formula-${index}-0001`,
        answers,
      }));
      const saved = await store.save(record);
      expect(saved.priceVerified).toBe(true);
      expect(saved.price).toEqual(record.price);
      const row = await db.query<{ pricing_breakdown: string }>(
        "SELECT pricing_breakdown FROM public.offers WHERE id = $1", [saved.offerId],
      );
      const breakdown = JSON.parse(row.rows[0]!.pricing_breakdown) as Record<string, any>;
      expect(breakdown.expectedResults).toEqual(
        record.pricing.resultsKind === "numbers"
          ? {
              impressions: record.pricing.expectedReach,
              visits: record.pricing.expectedVisits,
              leads: record.pricing.expectedLeads,
            }
          : null,
      );
      expect(breakdown.estimatedAdDays).toBe(record.pricing.estimatedAdDays);
    }
  });

  it("does not expose another client's old unscoped dedupe record when request ids collide", async () => {
    const ownAlert = await db.query<{ dedupe_key: string; meta: string }>(
      "SELECT dedupe_key, meta FROM public.alerts WHERE dedupe_key = $1",
      [`service-request:${CLIENT_USER_ID}:req-whatsapp-0001`],
    );
    expect(ownAlert.rows).toHaveLength(1);
    // Simulate the key left by the vulnerable 0008 implementation.
    await db.query("UPDATE public.alerts SET dedupe_key = 'service-request:req-whatsapp-0001' WHERE dedupe_key = $1", [ownAlert.rows[0]!.dedupe_key]);

    await authenticateAs(SECOND_CLIENT_USER_ID);
    const saved = await supabaseServiceRequestStore(pgliteRpcClient()).save(prepareServiceRequestOffer(whatsappRequest()));
    expect(saved.created).toBe(true);
    expect(saved.offerStatus).toBe("DRAFT");
    expect(saved.offerId).not.toBe(JSON.parse(ownAlert.rows[0]!.meta).offerId);
    const ownOffer = await db.query<{ customer_id: string }>("SELECT customer_id FROM public.offers WHERE id = $1", [saved.offerId]);
    expect(ownOffer.rows[0]?.customer_id).toBe(SECOND_CUSTOMER_ID);
    const retry = await supabaseServiceRequestStore(pgliteRpcClient()).save(prepareServiceRequestOffer(whatsappRequest()));
    expect(retry.created).toBe(false);
    expect(retry.offerId).toBe(saved.offerId);
  });

  it("revokes direct authenticated reads from offers and offer_items", async () => {
    const privileges = await db.query<{ offers: boolean; items: boolean; internalCost: boolean; itemDescription: boolean; verificationTable: boolean }>(
      `SELECT has_table_privilege('authenticated', 'public.offers', 'SELECT') AS offers,
              has_table_privilege('authenticated', 'public.offer_items', 'SELECT') AS items,
              has_column_privilege('authenticated', 'public.offers', 'internal_cost_minor', 'SELECT') AS "internalCost",
              has_column_privilege('authenticated', 'public.offer_items', 'description_ar', 'SELECT') AS "itemDescription",
              has_table_privilege('authenticated', 'public.ofoq_service_request_price_verifications', 'SELECT') AS "verificationTable"`,
    );
    expect(privileges.rows[0]).toEqual({ offers: false, items: false, internalCost: false, itemDescription: false, verificationTable: false });
    await db.query("SET ROLE authenticated");
    await expect(db.query("SELECT internal_cost_minor FROM public.offers LIMIT 1")).rejects.toThrow(/permission denied/i);
    await expect(db.query("SELECT description_ar FROM public.offer_items LIMIT 1")).rejects.toThrow(/permission denied/i);
    await expect(db.query("SELECT * FROM public.offer_items LIMIT 1")).rejects.toThrow(/permission denied/i);
    await expect(db.query("SELECT * FROM public.ofoq_service_request_price_verifications LIMIT 1")).rejects.toThrow(/permission denied/i);
    await db.query("RESET ROLE");
  });

  it("serves safe client-owned offer projections through the client RPC and restricts the admin RPC to staff", async () => {
    const clientDashboard = decodeJsonRecord(await callAsAuthenticated<unknown>(CLIENT_USER_ID, "SELECT public.ofoq_client_dashboard() AS result"));
    const clientOffers = clientDashboard.offers as Record<string, any>[];
    const dbOwnIds = await db.query<{ id: string }>("SELECT id FROM public.offers WHERE customer_id = $1", [CUSTOMER_ID]);
    const dbOtherIds = await db.query<{ id: string }>("SELECT id FROM public.offers WHERE customer_id = $1", [SECOND_CUSTOMER_ID]);
    const clientIds = clientOffers.map((offer) => offer.id);
    expect(clientIds.length).toBeGreaterThan(0);
    expect(new Set(clientIds)).toEqual(new Set(dbOwnIds.rows.map((row) => row.id)));
    expect(clientIds.some((id) => dbOtherIds.rows.some((other) => other.id === id))).toBe(false);
    for (const offer of clientOffers) {
      expect(offer).not.toHaveProperty("internalCostMinor");
      expect(offer).not.toHaveProperty("marginPct");
      expect(offer).not.toHaveProperty("internalNote");
      expect(offer).not.toHaveProperty("pricingBreakdown");
      expect(offer).not.toHaveProperty("createdByUserId");
      expect(offer).toHaveProperty("items");
    }
    expect(clientOffers.some((offer) => offer.totalMinor === null)).toBe(true);

    const secondDashboard = decodeJsonRecord(await callAsAuthenticated<unknown>(SECOND_CLIENT_USER_ID, "SELECT public.ofoq_client_dashboard() AS result"));
    const secondOffers = secondDashboard.offers as Record<string, any>[];
    expect(secondOffers.length).toBe(1);
    expect(secondOffers[0]!.id).toBe(dbOtherIds.rows[0]!.id);
    await expect(callAsAuthenticated<unknown>(CLIENT_USER_ID, "SELECT public.ofoq_admin_dashboard() AS result"))
      .rejects.toMatchObject({ code: "42501" });

    const adminDashboard = decodeJsonRecord(await callAsAuthenticated<unknown>(STAFF_USER_ID, "SELECT public.ofoq_admin_dashboard() AS result"));
    const adminOffers = adminDashboard.requests as Record<string, any>[];
    expect(adminOffers.length).toBeGreaterThan(0);
    for (const offer of adminOffers) {
      expect(offer).not.toHaveProperty("internalCostMinor");
      expect(offer).not.toHaveProperty("marginPct");
      expect(offer).not.toHaveProperty("internalNote");
      expect(offer).not.toHaveProperty("pricingBreakdown");
    }
  });

  it("the schema still refuses REQUESTED and the RPC always writes DRAFT", async () => {
    let code = "";
    try {
      await db.query(
        `INSERT INTO public.offers (id, code, customer_id, status, currency, created_at, updated_at)
         VALUES ('offer-requested', 'OFOQ-9999-999', $1, 'REQUESTED', 'USD', $2, $2)`,
        [CUSTOMER_ID, NOW],
      );
    } catch (error) {
      code = String((error as { code?: string }).code);
    }
    expect(code).toBe("23514");

    // A direct caller cannot switch the lifecycle with p_offer.status.
    await authenticateAs(CLIENT_USER_ID);
    const client = pgliteRpcClient();
    const response = await client.rpc("ofoq_client_service_request", {
      p_request_id: "req-requested-0003",
      p_title_ar: "ignored",
      p_title_en: "ignored",
      p_body_ar: "ignored",
      p_body_en: "ignored",
      p_offer: {
        status: "REQUESTED",
        total_minor: 1,
        pricing_breakdown: {
          serviceType: "ads", size: "medium", budgetBand: "200_500", budgetAmount: 500,
          budgetRange: "200-500", budgetSource: "option", targeting: "iraq_all",
        },
      },
      p_contact: { channel: "website", value: null },
    });
    expect(response.error).toBeNull();
    expect((response.data as Record<string, unknown>).offerStatus).toBe("DRAFT");
    const stored = await db.query<{ status: string }>("SELECT status FROM public.offers WHERE id = $1", [(response.data as Record<string, string>).offerId]);
    expect(stored.rows[0]?.status).toBe("DRAFT");

    // The status migration remains pending and is not part of today's setup bundle.
    const pending = fs.readFileSync(path.join(process.cwd(), "db", "migrations", "supabase", "pending", "0009_offers_requested_status.sql"), "utf8");
    expect(pending).toContain("'REQUESTED'");
    expect(pending).toContain("ADD CONSTRAINT offers_status_check");
    expect(setupBundle).not.toContain("ADD CONSTRAINT offers_status_check");
    expect(setupBundle).not.toContain("-- Source: db/migrations/supabase/pending/");
  });

  it("refuses a signed-out call and the store reports a clear error instead of a silent success", async () => {
    await authenticateAs(null);
    const store = supabaseServiceRequestStore(pgliteRpcClient());
    await expect(store.save(prepareServiceRequestOffer(whatsappRequest({ requestId: "req-anon-0004" })))).rejects.toMatchObject({
      name: "ServiceRequestStoreError",
      code: "SERVICE_REQUEST_SAVE_FAILED",
      details: expect.stringContaining("28000"),
    });
    const alerts = await db.query<{ count: string }>("SELECT count(*)::text AS count FROM public.alerts WHERE dedupe_key = 'service-request:req-anon-0004' OR dedupe_key LIKE '%:req-anon-0004'");
    expect(Number(alerts.rows[0]!.count)).toBe(0);
  });

  it("reports an uninstalled function as such (PGRST202 / 42883)", async () => {
    await authenticateAs(CLIENT_USER_ID);
    const client = {
      async rpc() {
        return { data: null, error: { code: "PGRST202", message: "Could not find the function public.ofoq_client_service_request(p_request_id) in the schema cache" } };
      },
    };
    await expect(supabaseServiceRequestStore(client).save(prepareServiceRequestOffer(whatsappRequest()))).rejects.toMatchObject({
      code: "SERVICE_REQUEST_RPC_NOT_INSTALLED",
      hint: expect.stringContaining("0010_harden_service_requests_and_offer_access.sql"),
    });
  });
});
