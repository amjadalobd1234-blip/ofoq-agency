/**
 * The database half of a completed guided request — executed for real.
 *
 * `ofoq_client_service_request()` (db/migrations/supabase/0008_service_requests.sql)
 * is extracted verbatim from docs/setup/supabase-setup.sql and run on a real
 * PostgreSQL server (PGlite) against the same file's table DDL. It proves, on
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
  buildServiceRequestAlert,
  prepareServiceRequestOffer,
  supabaseServiceRequestStore,
  type ServiceRequestSubmissionInput,
} from "../src/lib/services/service-requests.service";

const setupBundle = fs.readFileSync(path.join(process.cwd(), "docs", "setup", "supabase-setup.sql"), "utf8");

function tableDdl(name: string): string {
  const start = setupBundle.indexOf(`CREATE TABLE IF NOT EXISTS public.${name} (`);
  if (start < 0) throw new Error(`table ${name} not found in the setup bundle`);
  const end = setupBundle.indexOf("\n);", start);
  return setupBundle.slice(start, end + 3);
}

function functionDdl(name: string): string {
  const start = setupBundle.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in the setup bundle`);
  const end = setupBundle.indexOf("$function$;", start);
  return setupBundle.slice(start, end + "$function$;".length);
}

const STAFF_USER_ID = "d9352a7b-0000-0000-0000-000000000001";
const CLIENT_USER_ID = "d9352a7b-0000-0000-0000-000000000002";
const CUSTOMER_ID = "cust-0000-0000-0000-0000000000aa";
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
  `);
  for (const table of ["users", "customers", "projects", "offers", "conversations", "activities", "alerts", "notifications"]) {
    await db.exec(tableDdl(table));
  }
  await db.exec(functionDdl("ofoq_ensure_customer_profile"));
  await db.exec(functionDdl("ofoq_client_service_request"));

  await db.query(
    `INSERT INTO public.users (id, email, name, role, status, locale, created_at, updated_at)
     VALUES ($1, 'owner@ofoq.test', 'أمجد', 'OWNER', 'ACTIVE', 'ar', $3, $3),
            ($2, 'client@ofoq.test', 'عميل', 'CLIENT', 'ACTIVE', 'ar', $3, $3)`,
    [STAFF_USER_ID, CLIENT_USER_ID, NOW],
  );
  await db.query(
    `INSERT INTO public.customers (id, user_id, contact_name, email, status, created_at, updated_at)
     VALUES ($1, $2, 'امجد', 'alobdali8@gmail.com', 'ACTIVE', $3, $3)`,
    [CUSTOMER_ID, CLIENT_USER_ID, NOW],
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
    const migration = fs.readFileSync(path.join(process.cwd(), "db", "migrations", "supabase", "0008_service_requests.sql"), "utf8");
    expect(migration).not.toMatch(/PERFORM\s+public\.ofoq_client_escalate|SELECT\s+public\.ofoq_client_escalate/);
    expect(migration).not.toContain("'HUMAN_REQUEST'");
    expect(migration).not.toContain("'URGENT'");
  });

  it("saves a WhatsApp request: DRAFT offer, IMPORTANT/NEW_REQUEST alert, number as typed and wa.me link", async () => {
    await authenticateAs(CLIENT_USER_ID);
    const store = supabaseServiceRequestStore(pgliteRpcClient());
    const record = prepareServiceRequestOffer(whatsappRequest());

    const saved = await store.save(record);

    expect(saved.created).toBe(true);
    expect(saved.orderCode).toMatch(/^OFOQ-\d{4}-001$/);
    expect(saved.offerStatus).toBe("DRAFT");
    expect(saved.alert).toEqual({ category: "NEW_REQUEST", severity: "IMPORTANT" });

    const offer = await db.query<{ status: string; code: string; customer_id: string; pricing_breakdown: string; total_minor: string | number }>(
      "SELECT status, code, customer_id, pricing_breakdown, total_minor FROM public.offers WHERE id = $1",
      [saved.offerId],
    );
    expect(offer.rows[0]).toMatchObject({ status: SERVICE_REQUEST_OFFER_STATUS, code: saved.orderCode, customer_id: CUSTOMER_ID });
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
      dedupe_key: "service-request:req-whatsapp-0001",
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
    const offers = await db.query<{ count: string }>("SELECT count(*)::text AS count FROM public.offers");
    expect(Number(offers.rows[0]!.count)).toBe(1);
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

  it("the schema still refuses REQUESTED, which is why DRAFT is written until 0009 lands", async () => {
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

    // The RPC refuses it up front with a message that names the pending migration.
    await authenticateAs(CLIENT_USER_ID);
    const client = pgliteRpcClient();
    const record = prepareServiceRequestOffer(whatsappRequest({ requestId: "req-requested-0003" }));
    const alert = buildServiceRequestAlert(record, null);
    const response = await client.rpc("ofoq_client_service_request", {
      p_request_id: record.requestId,
      p_title_ar: alert.title_ar,
      p_title_en: alert.title_en,
      p_body_ar: alert.body_ar,
      p_body_en: alert.body_en,
      p_offer: { status: "REQUESTED", currency: "USD", total_minor: 0 },
      p_contact: { channel: "email", value: null },
    });
    expect(response.error?.code).toBe("22023");
    expect(response.error?.message).toContain("0009_offers_requested_status.sql");

    // The pending migration itself is valid SQL that widens the CHECK.
    const pending = fs.readFileSync(path.join(process.cwd(), "db", "migrations", "supabase", "pending", "0009_offers_requested_status.sql"), "utf8");
    expect(pending).toContain("'REQUESTED'");
    // It is NOT part of today's setup bundle (only mentioned in 0008's comment).
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
    const alerts = await db.query<{ count: string }>("SELECT count(*)::text AS count FROM public.alerts WHERE dedupe_key = 'service-request:req-anon-0004'");
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
      hint: expect.stringContaining("0008_service_requests.sql"),
    });
  });
});
