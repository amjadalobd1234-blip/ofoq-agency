import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Wiring guard for the escalation SQL.
 *
 * The client portal has no direct table access, so the alert row, the
 * conversation status and the notifications can only be written by these
 * SECURITY DEFINER functions. This test pins the contract between the
 * TypeScript service (which passes `p_*` arguments) and the SQL, and makes sure
 * the manual Supabase bundle still ships the functions after a regeneration.
 *
 * Note: these are structural assertions. The functions themselves are executed
 * by Supabase/PostgreSQL, which is not available in the test sandbox.
 */
const rootDir = process.cwd();
const supabaseDir = path.join(rootDir, "db", "migrations", "supabase");
const escalationSql = fs.readFileSync(path.join(supabaseDir, "0003_escalation_alerts.sql"), "utf8");
/**
 * Migration 0004 replaces `ofoq_client_escalate` with a version that works for
 * owners and partners too, so the escalate contract is asserted against the
 * file that actually ships it.
 */
const ownerSupportSql = fs.readFileSync(path.join(supabaseDir, "0004_escalation_owner_support.sql"), "utf8");
const portalSql = fs.readFileSync(path.join(supabaseDir, "0001_auth_portal.sql"), "utf8");
const setupSql = fs.readFileSync(path.join(rootDir, "docs", "setup", "supabase-setup.sql"), "utf8");

describe("escalation RPC contract", () => {
  it("defines both functions with the arguments the service sends", () => {
    expect(ownerSupportSql).toContain("CREATE OR REPLACE FUNCTION public.ofoq_client_escalate(");
    expect(escalationSql).toContain("CREATE OR REPLACE FUNCTION public.ofoq_escalation_email_result(");

    // Every argument raiseClientEscalation() passes must exist in the signature.
    for (const arg of [
      "p_conversation_id text",
      "p_category text",
      "p_severity text",
      "p_title_ar text",
      "p_title_en text",
      "p_body_ar text",
      "p_body_en text",
      "p_reason text",
      "p_signals text",
    ]) {
      expect(ownerSupportSql).toContain(arg);
    }
    expect(escalationSql).toContain("p_delivered boolean");
  });

  it("writes the alerts row the dashboard filters on", () => {
    expect(ownerSupportSql).toContain("INSERT INTO public.alerts");
    expect(ownerSupportSql).toContain("'ANY_STAFF', 'NEW'");
    expect(ownerSupportSql).toContain("'conversation', p_conversation_id, v_customer_id");
    expect(ownerSupportSql).toMatch(/v_category NOT IN \('HUMAN_REQUEST', 'NEW_LEAD'\)/);
    expect(ownerSupportSql).toMatch(/v_severity NOT IN \('URGENT', 'IMPORTANT'\)/);
    expect(ownerSupportSql).toContain("عميل جديد يطلب تواصل");
    expect(ownerSupportSql).toContain("New client requesting contact");
    // One open alert per conversation, category and day — no flooding /admin.
    expect(ownerSupportSql).toContain("'escalation:' || p_conversation_id || ':' || v_category || ':' || v_day");
  });

  it("moves the conversation to PENDING and notifies owners and partners", () => {
    expect(ownerSupportSql).toContain("SET status = 'PENDING'");
    expect(ownerSupportSql).toContain("u.role IN ('OWNER', 'PARTNER') AND u.status = 'ACTIVE'");
    expect(ownerSupportSql).toContain("INSERT INTO public.notifications");
    expect(ownerSupportSql).toContain("'IN_APP'");
    expect(ownerSupportSql).toContain("'EMAIL'");
    // A deduplicated escalation must not notify the team twice.
    expect(ownerSupportSql).toContain("IF v_created THEN");
    expect(ownerSupportSql).toContain("INSERT INTO public.activities");
    expect(ownerSupportSql).toContain("'escalation.raised'");
  });

  it("stays closed to anonymous callers and checks conversation ownership", () => {
    expect(ownerSupportSql).toContain("REVOKE ALL ON FUNCTION public.ofoq_client_escalate");
    expect(ownerSupportSql).toContain("GRANT EXECUTE ON FUNCTION public.ofoq_client_escalate");
    expect(ownerSupportSql).toContain("SECURITY DEFINER");
    // A client may only escalate their own conversation …
    expect(ownerSupportSql).toContain("v_owner_user_id <> v_user_id");
    // … and an active OWNER/PARTNER may escalate any web conversation.
    expect(ownerSupportSql).toContain("v_is_staff := v_role IN ('OWNER', 'PARTNER')");
    expect(ownerSupportSql).toContain("IF NOT v_is_staff AND (v_owner_user_id IS NULL");
  });

  it("ships in the generated Supabase setup bundle", () => {
    expect(setupSql).toContain(ownerSupportSql.trim());
    expect(setupSql).toContain("public.ofoq_client_escalate");
    expect(setupSql).toContain("public.ofoq_escalation_email_result");
  });
});

describe("escalation works for accounts with no client record (owners)", () => {
  it("resolves the conversation before any customer lookup", () => {
    // The old version joined `customers` while resolving the conversation, so
    // an account with no `customers` row got «Conversation not found» for a
    // conversation that existed all along.
    const resolveIndex = ownerSupportSql.indexOf("INTO v_conversation_id, v_customer_id");
    const customerIndex = ownerSupportSql.indexOf("FROM public.customers AS cu");
    expect(resolveIndex).toBeGreaterThan(-1);
    expect(customerIndex).toBeGreaterThan(resolveIndex);
    // Ownership is checked from the conversation's own customer row, and a
    // missing one never hides the conversation itself.
    expect(ownerSupportSql).toContain("SELECT c.id, c.customer_id");
  });

  it("still writes the alert when there is no customer record to link", () => {
    // alerts.customer_id is nullable and /admin LEFT JOINs it: the alert
    // matters more than the link. A readable identity is still recorded.
    expect(ownerSupportSql).toContain("coalesce(v_customer_id, '-')");
    expect(ownerSupportSql).toContain("'raisedByRole', v_role");
    expect(ownerSupportSql).toContain(
      "v_customer_name := coalesce(nullif(trim(v_customer_name), ''), nullif(trim(v_profile_name), ''), 'عميل أفق')",
    );
    expect(ownerSupportSql).toContain("'identity', jsonb_build_object(");
  });

  it("explains every refusal instead of the misleading «Conversation not found»", () => {
    expect(ownerSupportSql).toContain("'Conversation not found (user=% role=% conversation=%)'");
    expect(ownerSupportSql).toContain("'Not allowed to escalate this conversation (user=% role=% customer=% owner=% conversation=%)'");
  });

  it("creates the missing client record lazily, and backfills the existing ones", () => {
    expect(portalSql).toContain("CREATE OR REPLACE FUNCTION public.ofoq_ensure_customer_profile()");
    expect(portalSql).toContain("REVOKE ALL ON FUNCTION public.ofoq_ensure_customer_profile() FROM PUBLIC, anon");
    expect(portalSql).toContain("GRANT EXECUTE ON FUNCTION public.ofoq_ensure_customer_profile() TO authenticated");
    // The chat bootstrap no longer locks such an account out of the assistant.
    expect(portalSql).toContain("v_customer_id := public.ofoq_ensure_customer_profile();");
    // One-off repair for accounts registered before the signup trigger existed.
    expect(ownerSupportSql).toContain("WHERE NOT EXISTS (SELECT 1 FROM public.customers AS c WHERE c.user_id = u.id)");
    expect(ownerSupportSql).toContain("ON CONFLICT (id) DO NOTHING");
    expect(setupSql).toContain("public.ofoq_ensure_customer_profile");
  });

  it("opens an authenticated INSERT policy on alerts", () => {
    expect(ownerSupportSql).toContain("ALTER TABLE public.alerts ENABLE ROW LEVEL SECURITY;");
    expect(ownerSupportSql).toContain("DROP POLICY IF EXISTS alerts_insert_authenticated ON public.alerts;");
    expect(ownerSupportSql).toContain("CREATE POLICY alerts_insert_authenticated ON public.alerts");
    expect(ownerSupportSql).toContain("FOR INSERT TO authenticated");
    // Narrower than `true`: only an escalation-shaped row may be inserted.
    expect(ownerSupportSql).toContain("entity_type = 'conversation'");
    expect(ownerSupportSql).toContain("target_role = 'ANY_STAFF'");
    // The table GRANT stays revoked, so the RPC remains the only writable path.
    expect(ownerSupportSql).not.toContain("GRANT INSERT");
  });

  it("ships a diagnostics RPC that never dies on a missing table", () => {
    expect(ownerSupportSql).toContain("CREATE OR REPLACE FUNCTION public.ofoq_escalation_diagnostics(");
    expect(ownerSupportSql).toContain("GRANT EXECUTE ON FUNCTION public.ofoq_escalation_diagnostics(text) TO authenticated");
    expect(ownerSupportSql).toContain("IF to_regclass('public.alerts') IS NULL THEN");
    expect(ownerSupportSql).toContain("'hasCustomerRecord', v_customer_id IS NOT NULL");
    expect(ownerSupportSql).toContain("'ownedByCaller', cu.user_id IS NOT NULL AND cu.user_id = v_user_id");
    expect(ownerSupportSql).toContain("'escalateFunctionExists'");
    expect(setupSql).toContain("public.ofoq_escalation_diagnostics");
  });
});

describe("admin dashboard reads the escalation alerts", () => {
  it("counts URGENT and IMPORTANT alerts as the urgent total", () => {
    expect(portalSql).toContain(
      "'urgentAlerts', (SELECT count(*) FROM public.alerts WHERE severity IN ('URGENT', 'IMPORTANT')",
    );
    expect(portalSql).toContain("'criticalAlerts'");
    expect(portalSql).toContain(
      "'newLeads', (SELECT count(*) FROM public.alerts WHERE category IN ('NEW_LEAD', 'HUMAN_REQUEST')",
    );
  });

  it("returns the new-request list and the client behind each alert", () => {
    expect(portalSql).toContain("'leadRequests', v_leads");
    expect(portalSql).toContain("category IN ('NEW_LEAD', 'HUMAN_REQUEST') AND status IN ('NEW', 'ACKNOWLEDGED')");
    expect(portalSql).toContain("'customerName', c.contact_name");
    // The manual bundle the owner applies must carry the same definition.
    expect(setupSql).toContain("'leadRequests', v_leads");
    // An escalation with no customer record must still be listed.
    expect(portalSql).toContain("LEFT JOIN public.customers AS c ON c.id = a.customer_id");
  });
});
