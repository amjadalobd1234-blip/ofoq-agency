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
const escalationSql = fs.readFileSync(
  path.join(rootDir, "db", "migrations", "supabase", "0003_escalation_alerts.sql"),
  "utf8",
);
const portalSql = fs.readFileSync(
  path.join(rootDir, "db", "migrations", "supabase", "0001_auth_portal.sql"),
  "utf8",
);
const setupSql = fs.readFileSync(path.join(rootDir, "docs", "setup", "supabase-setup.sql"), "utf8");

describe("escalation RPC contract", () => {
  it("defines both functions with the arguments the service sends", () => {
    expect(escalationSql).toContain("CREATE OR REPLACE FUNCTION public.ofoq_client_escalate(");
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
      expect(escalationSql).toContain(arg);
    }
    expect(escalationSql).toContain("p_delivered boolean");
  });

  it("writes the alerts row the dashboard filters on", () => {
    expect(escalationSql).toContain("INSERT INTO public.alerts");
    expect(escalationSql).toContain("'ANY_STAFF', 'NEW'");
    expect(escalationSql).toContain("'conversation', p_conversation_id, v_customer_id");
    expect(escalationSql).toMatch(/v_category NOT IN \('HUMAN_REQUEST', 'NEW_LEAD'\)/);
    expect(escalationSql).toMatch(/v_severity NOT IN \('URGENT', 'IMPORTANT'\)/);
    expect(escalationSql).toContain("عميل جديد يطلب تواصل");
    expect(escalationSql).toContain("New client requesting contact");
    // One open alert per conversation, category and day — no flooding /admin.
    expect(escalationSql).toContain("'escalation:' || p_conversation_id || ':' || v_category || ':' || v_day");
  });

  it("moves the conversation to PENDING and notifies owners and partners", () => {
    expect(escalationSql).toContain("SET status = 'PENDING'");
    expect(escalationSql).toContain("u.role IN ('OWNER', 'PARTNER') AND u.status = 'ACTIVE'");
    expect(escalationSql).toContain("INSERT INTO public.notifications");
    expect(escalationSql).toContain("'IN_APP'");
    expect(escalationSql).toContain("'EMAIL'");
    // A deduplicated escalation must not notify the team twice.
    expect(escalationSql).toContain("IF v_created THEN");
    expect(escalationSql).toContain("INSERT INTO public.activities");
    expect(escalationSql).toContain("'escalation.raised'");
  });

  it("stays closed to anonymous callers and checks conversation ownership", () => {
    expect(escalationSql).toContain("REVOKE ALL ON FUNCTION public.ofoq_client_escalate");
    expect(escalationSql).toContain("GRANT EXECUTE ON FUNCTION public.ofoq_client_escalate");
    expect(escalationSql).toContain("cu.user_id = v_user_id");
    expect(escalationSql).toContain("SECURITY DEFINER");
    expect(escalationSql).toContain("RAISE EXCEPTION 'Conversation not found' USING ERRCODE = '42501'");
  });

  it("ships in the generated Supabase setup bundle", () => {
    expect(setupSql).toContain(escalationSql.trim());
    expect(setupSql).toContain("public.ofoq_client_escalate");
    expect(setupSql).toContain("public.ofoq_escalation_email_result");
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
  });
});
