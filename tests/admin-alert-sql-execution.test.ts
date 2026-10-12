/**
 * The database half of the reply button — executed for real.
 *
 * An earlier round proved the HTTP path (component → route → PostgREST). This
 * file proves what that path lands on: a real PostgreSQL server (PGlite,
 * PostgreSQL 18 in WebAssembly) running **the exact SQL this repository ships**
 * — the `ofoq_admin_*` functions are extracted verbatim from
 * docs/setup/supabase-setup.sql, and the tables from the same file's DDL.
 *
 * It answers, on a real database, the two questions the staff page raised:
 *
 *   1. «هل أسماء الوسائط مطابقة؟» — `pg_get_function_arguments` is read back and
 *      compared with the argument names the routes send. Calling the function
 *      with a RENAMED argument (the `p_conversation_id` hypothesis) is shown to
 *      fail with 42883, exactly like PostgREST would answer PGRST202.
 *   2. «هل تصل رسالة بـ sender_type='STAFF'؟» — the reply is sent with the same
 *      arguments the button sends, and the `public.messages` row is read back,
 *      together with the conversation counters, the acknowledgement of a NEW
 *      alert and the append-only activity trail.
 *
 * The write-free promise the diagnostics make (`GET /api/debug/alerts` probes
 * with a nil alert id) is verified here too: P0002, and no row anywhere.
 */
import fs from "node:fs";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const setupBundle = fs.readFileSync(path.join(process.cwd(), "docs", "setup", "supabase-setup.sql"), "utf8");

/** The table definition exactly as the installer writes it. */
function tableDdl(name: string): string {
  const start = setupBundle.indexOf(`CREATE TABLE IF NOT EXISTS public.${name} (`);
  if (start < 0) throw new Error(`table ${name} not found in the setup bundle`);
  const end = setupBundle.indexOf("\n);", start);
  return setupBundle.slice(start, end + 3);
}

/** The function body exactly as the installer writes it. */
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

let db: PGlite;
let alertSeq = 0;

/** One staff escalation of a client conversation — what the page opens. */
async function createAlert(): Promise<string> {
  alertSeq += 1;
  const id = `alert-0000-0000-0000-00000000${String(alertSeq).padStart(4, "0")}`;
  await db.query(
    `INSERT INTO public.alerts
       (id, severity, category, title_ar, title_en, body_ar, body_en, entity_type, entity_id,
        customer_id, target_role, status, dedupe_key, is_demo, created_at, updated_at)
     VALUES ($1, 'URGENT', 'HUMAN_REQUEST', 'عميل جديد يطلب تواصل', 'New client wants a call',
             'العميل طلب فريق بشري', 'The client asked for a human', 'conversation', $2, $3,
             'ANY_STAFF', 'NEW', $4, 0, $5, $5)`,
    [id, CONVERSATION_ID, CUSTOMER_ID, `dedupe-${id}`, NOW],
  );
  return id;
}

/** Acts as the given user, the way Supabase's `auth.uid()` reads the JWT claim. */
async function authenticateAs(userId: string): Promise<void> {
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [userId]);
}

async function countMessages(): Promise<number> {
  const result = await db.query<{ count: string }>("SELECT count(*)::text AS count FROM public.messages WHERE sender_type = 'STAFF'");
  return Number(result.rows[0].count);
}

async function expectPostgresError(sql: string, params: unknown[], code: string): Promise<string> {
  try {
    await db.query(sql, params);
  } catch (error) {
    const failure = error as { code?: string | number; message?: string };
    // PGlite reports the SQLSTATE as a string, node-postgres as a number.
    expect(String(failure.code), `${sql} should fail with ${code}`).toBe(String(code));
    return failure.message ?? "";
  }
  throw new Error(`expected ${code}, but the statement succeeded: ${sql}`);
}

beforeAll(async () => {
  db = new PGlite();

  // Supabase provides auth.uid(); here it reads the same kind of session claim.
  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
    LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
  `);

  for (const table of ["users", "customers", "conversations", "messages", "activities", "alerts"]) {
    await db.exec(tableDdl(table));
  }

  // The staff predicate, then the five alert RPCs — the shipped definitions.
  await db.exec(functionDdl("ofoq_is_staff"));
  for (const fn of ["ofoq_admin_alerts", "ofoq_admin_alert_details", "ofoq_admin_acknowledge_alert", "ofoq_admin_resolve_alert", "ofoq_admin_reply_to_client"]) {
    await db.exec(functionDdl(fn));
  }

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
  await db.query(
    `INSERT INTO public.messages (id, conversation_id, sender_type, sender_label, body, language, created_at, is_demo)
     VALUES ('msg-client-1', $1, 'CLIENT', 'امجد', 'أرغب بالتحدث مع شخص', 'ar', $2, 0)`,
    [CONVERSATION_ID, NOW],
  );

  await authenticateAs(STAFF_USER_ID);
});

afterAll(async () => {
  await db?.close();
});

describe("the shipped SQL, on a real PostgreSQL", () => {
  it("declares exactly the argument names the routes send", async () => {
    const result = await db.query<{ signature: string; args: string }>(
      `SELECT p.oid::regprocedure::text AS signature, pg_get_function_arguments(p.oid) AS args
       FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'ofoq_admin_reply_to_client'`,
    );
    expect(result.rows).toHaveLength(1);
    // The user's expectation, confirmed: p_alert_id / p_body / p_language.
    expect(result.rows[0].args).toContain("p_alert_id text");
    expect(result.rows[0].args).toContain("p_body text");
    expect(result.rows[0].args).toContain("p_language text");
    expect(result.rows[0].signature).toBe("ofoq_admin_reply_to_client(text,text,text)");

    const resolve = await db.query<{ args: string }>(
      `SELECT pg_get_function_arguments(p.oid) AS args
       FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'ofoq_admin_resolve_alert'`,
    );
    // `pg_get_function_arguments` includes the default; the names are what matter.
    expect(resolve.rows[0].args).toMatch(/^p_alert_id text, p_note text( DEFAULT .*)?$/);
  });

  it("refuses a call whose argument names differ — the failure the button must never hit", async () => {
    const alertId = await createAlert();
    // `p_conversation_id` — the name the page was suspected of sending.
    const message = await expectPostgresError(
      `SELECT public.ofoq_admin_reply_to_client(p_conversation_id => $1, p_body => $2, p_language => $3)`,
      [CONVERSATION_ID, "مرحبا", "ar"],
      "42883",
    );
    expect(message).toContain("ofoq_admin_reply_to_client");
    // Nothing was written for the alert that was actually addressed.
    expect(await countMessages()).toBe(0);
    const alert = await db.query<{ status: string }>("SELECT status FROM public.alerts WHERE id = $1", [alertId]);
    expect(alert.rows[0].status).toBe("NEW");
  });

  it("writes a STAFF message when the reply is sent with the real argument names", async () => {
    const alertId = await createAlert();
    const body = "شكرًا لتواصلك، سنتصل بك اليوم.";

    const result = await db.query<{ payload: { messages: Array<{ sender: string; body: string }>; alert: { status: string } } }>(
      `SELECT public.ofoq_admin_reply_to_client(p_alert_id => $1, p_body => $2, p_language => $3) AS payload`,
      [alertId, body, "ar"],
    );

    // The row the E2E asks for.
    const stored = await db.query<{
      sender_type: string;
      sender_user_id: string;
      sender_label: string;
      body: string;
      language: string;
      meta: string;
    }>("SELECT sender_type, sender_user_id, sender_label, body, language, meta FROM public.messages WHERE sender_type = 'STAFF'");
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]).toMatchObject({
      sender_type: "STAFF",
      sender_user_id: STAFF_USER_ID,
      sender_label: "أمجد",
      body,
      language: "ar",
    });
    expect(stored.rows[0].meta).toContain("admin-alert-centre");
    expect(stored.rows[0].meta).toContain(alertId);

    // The conversation the client sees: reopened, counted for them, staff caught up.
    const conversation = await db.query<{ status: string; unread_for_client: string; unread_for_staff: string; last_message_at: string | null }>(
      "SELECT status, unread_for_client::text, unread_for_staff::text, last_message_at FROM public.conversations WHERE id = $1",
      [CONVERSATION_ID],
    );
    expect(conversation.rows[0]).toMatchObject({ status: "OPEN", unread_for_client: "1", unread_for_staff: "0" });
    expect(conversation.rows[0].last_message_at).toBeTruthy();

    // Replying is an acknowledgement when nobody had claimed the alert.
    const alert = await db.query<{ status: string; acknowledged_by_user_id: string | null }>(
      "SELECT status, acknowledged_by_user_id FROM public.alerts WHERE id = $1",
      [alertId],
    );
    expect(alert.rows[0]).toMatchObject({ status: "ACKNOWLEDGED", acknowledged_by_user_id: STAFF_USER_ID });

    // The append-only trail the page prints under «سجل التنبيه».
    const activity = await db.query<{ action: string; actor_user_id: string | null }>(
      "SELECT action, actor_user_id FROM public.activities WHERE entity_type = 'alert' AND entity_id = $1",
      [alertId],
    );
    expect(activity.rows.map((row) => row.action)).toEqual(["alert.replied_to_client"]);
    expect(activity.rows[0].actor_user_id).toBe(STAFF_USER_ID);

    // And the payload the page re-renders from already contains the new message.
    expect(result.rows[0].payload.messages.some((message) => message.sender === "STAFF" && message.body === body)).toBe(true);
    expect(result.rows[0].payload.alert.status).toBe("ACKNOWLEDGED");
  });

  it("keeps the reply inside the conversation of its own alert", async () => {
    const otherCustomer = "cust-0000-0000-0000-0000000000bb";
    const otherConversation = "conv-0000-0000-0000-0000000000bb";
    await db.query(
      `INSERT INTO public.customers (id, contact_name, status, created_at, updated_at)
       VALUES ($1, 'عميل آخر', 'ACTIVE', $2, $2)`,
      [otherCustomer, NOW],
    );
    await db.query(
      `INSERT INTO public.conversations (id, customer_id, channel, status, is_demo, created_at, updated_at)
       VALUES ($1, $2, 'WEB', 'OPEN', 0, $3, $3)`,
      [otherConversation, otherCustomer, NOW],
    );
    const alertId = await createAlert();

    await db.query(`SELECT public.ofoq_admin_reply_to_client(p_alert_id => $1, p_body => $2, p_language => 'ar')`, [alertId, "رد لمحادثة التنبيه"]);

    // A reply never lands in a conversation the alert is not attached to.
    const wrong = await db.query("SELECT 1 FROM public.messages WHERE conversation_id = $1", [otherConversation]);
    expect(wrong.rows).toHaveLength(0);
    const right = await db.query<{ body: string }>("SELECT body FROM public.messages WHERE conversation_id = $1 AND sender_type = 'STAFF'", [CONVERSATION_ID]);
    expect(right.rows.map((row) => row.body)).toContain("رد لمحادثة التنبيه");
  });

  it("resolves the alert and preserves the note in the activity trail", async () => {
    const alertId = await createAlert();
    const result = await db.query<{ payload: { alert: { status: string; resolvedAt: string | null; resolutionNote: string | null } } }>(
      `SELECT public.ofoq_admin_resolve_alert(p_alert_id => $1, p_note => $2) AS payload`,
      [alertId, "تم الاتصال بالعميل."],
    );

    const alert = await db.query<{ status: string; resolved_at: string | null }>(
      "SELECT status, resolved_at FROM public.alerts WHERE id = $1",
      [alertId],
    );
    expect(alert.rows[0].status).toBe("RESOLVED");
    expect(alert.rows[0].resolved_at).toBeTruthy();

    const activity = await db.query<{ summary: string }>(
      "SELECT summary FROM public.activities WHERE entity_type = 'alert' AND entity_id = $1 AND action = 'alert.resolved'",
      [alertId],
    );
    expect(activity.rows[0].summary).toBe("Alert resolved: تم الاتصال بالعميل.");
    // The page shows this note back to the operator (the details RPC reads the
    // latest `alert.resolved` summary).
    expect(result.rows[0].payload.alert.resolutionNote).toContain("تم الاتصال بالعميل.");

    // Resolving twice is idempotent: no second activity row, no error.
    await db.query(`SELECT public.ofoq_admin_resolve_alert(p_alert_id => $1, p_note => NULL)`, [alertId]);
    const again = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM public.activities WHERE entity_id = $1 AND action = 'alert.resolved'",
      [alertId],
    );
    expect(again.rows[0].count).toBe("1");
  });

  it("refuses a non-staff session before writing anything", async () => {
    const alertId = await createAlert();
    await authenticateAs(CLIENT_USER_ID);
    const before = await countMessages();

    const message = await expectPostgresError(
      `SELECT public.ofoq_admin_reply_to_client(p_alert_id => $1, p_body => $2, p_language => $3)`,
      [alertId, "محاولة من غير موظف", "ar"],
      "42501",
    );
    expect(message).toContain("Staff access required");
    expect(await countMessages()).toBe(before);

    await authenticateAs(STAFF_USER_ID);
  });

  it("is write-free for the nil alert id the diagnostics probe with", async () => {
    const before = await countMessages();
    const nilId = "00000000-0000-0000-0000-000000000000";

    // Exactly what GET /api/debug/alerts sends for the two write buttons.
    const replyMessage = await expectPostgresError(
      `SELECT public.ofoq_admin_reply_to_client(p_alert_id => $1, p_body => $2, p_language => 'ar')`,
      [nilId, "[diagnostic probe — not a client reply]"],
      "P0002",
    );
    expect(replyMessage).toContain("Alert is not linked to a client conversation");

    const resolveMessage = await expectPostgresError(`SELECT public.ofoq_admin_resolve_alert(p_alert_id => $1, p_note => NULL)`, [nilId], "P0002");
    expect(resolveMessage).toContain("Alert not found");

    // P0002 is the «argument names resolve correctly» verdict — and it costs nothing.
    expect(await countMessages()).toBe(before);
    const alert = await db.query("SELECT 1 FROM public.alerts WHERE id = $1", [nilId]);
    expect(alert.rows).toHaveLength(0);
  });

  it("returns the details payload the page renders, STAFF message included", async () => {
    const alertId = await createAlert();
    await db.query(`SELECT public.ofoq_admin_reply_to_client(p_alert_id => $1, p_body => $2, p_language => 'en')`, [alertId, "We will call you today."]);

    const details = await db.query<{
      payload: {
        alert: { id: string; status: string; conversationId: string };
        conversation: { id: string; status: string } | null;
        messages: Array<{ sender: string; body: string; language: string | null }>;
        activities: Array<{ action: string }>;
      };
    }>(`SELECT public.ofoq_admin_alert_details(p_alert_id => $1) AS payload`, [alertId]);

    const payload = details.rows[0].payload;
    expect(payload.alert).toMatchObject({ id: alertId, status: "ACKNOWLEDGED", conversationId: CONVERSATION_ID });
    expect(payload.conversation?.id).toBe(CONVERSATION_ID);
    expect(payload.messages.at(-1)).toMatchObject({ sender: "STAFF", body: "We will call you today.", language: "en" });
    expect(payload.activities.map((activity) => activity.action)).toContain("alert.replied_to_client");
  });
});
