import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const rootDir = process.cwd();
const migration = fs.readFileSync(path.join(rootDir, "db", "migrations", "supabase", "0007_admin_alerts.sql"), "utf8");
const setup = fs.readFileSync(path.join(rootDir, "docs", "setup", "supabase-setup.sql"), "utf8");
const dashboard = fs.readFileSync(path.join(rootDir, "src", "components", "admin-dashboard.tsx"), "utf8");
const listRoute = fs.readFileSync(path.join(rootDir, "src", "app", "api", "admin", "alerts", "route.ts"), "utf8");
const detailRoute = fs.readFileSync(path.join(rootDir, "src", "app", "api", "admin", "alerts", "[id]", "route.ts"), "utf8");

/** Structural contract for the staff alert centre. SQL itself runs on Supabase. */
describe("admin alert centre", () => {
  it("ships the staff-only list, details and lifecycle RPCs", () => {
    for (const name of [
      "ofoq_admin_alerts",
      "ofoq_admin_alert_details",
      "ofoq_admin_acknowledge_alert",
      "ofoq_admin_resolve_alert",
      "ofoq_admin_reply_to_client",
    ]) {
      expect(migration).toContain(`FUNCTION public.${name}`);
      expect(migration).toContain(`REVOKE ALL ON FUNCTION public.${name}`);
      expect(migration).toContain(`GRANT EXECUTE ON FUNCTION public.${name}`);
      expect(setup).toContain(`FUNCTION public.${name}`);
    }
    expect(migration).toContain("IF NOT public.ofoq_is_staff()");
    expect(migration).toContain("sender_type, sender_user_id, sender_label, body");
    expect(migration).toContain("'STAFF'");
    expect(migration).toContain("'alert.acknowledged'");
    expect(migration).toContain("'alert.resolved'");
    expect(migration).toContain("'alert.replied_to_client'");
  });

  it("keeps admin routes behind both a browser role gate and a database RPC", () => {
    // The staff gate: the caller's own role must be OWNER/PARTNER, checked from
    // this request's session before the RPC runs.
    expect(listRoute).toContain('requireOwnRole(auth.client, auth.user.id, ["OWNER", "PARTNER"], { requestId: auth.requestId })');
    // …and every refusal path writes one line the host's logs can be filtered on.
    expect(listRoute).toContain("logAdminAlertGateFailure(");
    expect(listRoute).toContain("logAdminAlertFailure(");
    expect(listRoute).toContain('rpc("ofoq_admin_alerts"');
    expect(detailRoute).toContain('rpc("ofoq_admin_alert_details"');
    expect(detailRoute).toContain('rpc("ofoq_admin_acknowledge_alert"');
    expect(detailRoute).toContain('rpc("ofoq_admin_resolve_alert"');
    expect(detailRoute).toContain('rpc("ofoq_admin_reply_to_client"');
  });

  it("turns dashboard sections into accessible tabs and alert rows into links", () => {
    expect(dashboard).toContain('role="tablist"');
    expect(dashboard).toContain('role="tab"');
    expect(dashboard).toContain('setActiveTab(tab.id)');
    expect(dashboard).toContain('href={`/admin/alerts/${encodeURIComponent(alert.id)}`}');
    expect(dashboard).toContain('href={`/admin/alerts/${encodeURIComponent(lead.id)}`}');
    expect(dashboard).toContain('href="/admin/alerts"');
  });
});
