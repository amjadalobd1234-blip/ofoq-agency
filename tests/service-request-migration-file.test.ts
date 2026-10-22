/** The stand-alone SQL copy must stay aligned with the hardened migration. */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const setupDir = path.join(process.cwd(), "docs", "setup");
const file = fs.readFileSync(path.join(setupDir, "service-requests-migration.sql"), "utf8");
const bundle = fs.readFileSync(path.join(setupDir, "supabase-setup.sql"), "utf8");
const migration = fs.readFileSync(
  path.join(process.cwd(), "db", "migrations", "supabase", "0010_harden_service_requests_and_offer_access.sql"),
  "utf8",
);
const projectPlanMigration = fs.readFileSync(
  path.join(process.cwd(), "db", "migrations", "supabase", "0011_project_plans.sql"),
  "utf8",
);

/** Extract the latest RPC definition when the generated bundle includes 0008 and 0010. */
function functionDdl(source: string): string {
  const start = source.lastIndexOf("CREATE OR REPLACE FUNCTION public.ofoq_client_service_request(");
  if (start < 0) throw new Error("the RPC is missing");
  const end = source.indexOf("$function$;", start);
  return source.slice(start, end + "$function$;".length);
}

/** Extract the latest dashboard definition (0001 first, 0010 replacement last). */
function dashboardDdl(source: string): string {
  const start = source.lastIndexOf("CREATE OR REPLACE FUNCTION public.ofoq_client_dashboard(");
  if (start < 0) throw new Error("the dashboard RPC is missing");
  const end = source.indexOf("$function$;", start);
  return source.slice(start, end + "$function$;".length);
}

describe("docs/setup/service-requests-migration.sql — hardened manual migration", () => {
  it("documents cautious application and enforces database-side price and access controls", () => {
    expect(file).toContain("خطوات التطبيق");
    expect(file).toContain("Supabase Dashboard");
    expect(file).toContain("SQL Editor");
    expect(file).toContain("0010_harden_service_requests_and_offer_access.sql");
    expect(file).toContain("0008_service_requests");
    expect(file).toContain("لا تشغّل pending/0009_offers_requested_status.sql");
    expect(file).toContain("لا تُحذف أو تُعدّل عروض سابقة");

    const signature = "public.ofoq_client_service_request(text, text, text, text, text, jsonb, jsonb, jsonb, text, text)";
    expect(file).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC, anon;`);
    expect(file).toContain(`GRANT EXECUTE ON FUNCTION ${signature} TO authenticated;`);
    expect(file).toContain("SECURITY DEFINER");
    expect(file).toContain("SET search_path = ''");
    expect(file).toContain("priceVerified");
    expect(file).toContain("calculationVersion");
    expect(file).toContain("v_total_minor := NULL");
    expect(file).toContain("REVOKE ALL PRIVILEGES ON TABLE public.offers, public.offer_items FROM PUBLIC, anon, authenticated;");
    expect(file).toContain("v_dedupe_key := 'service-request:' || v_user_id || ':' || v_request_id;");
    expect(file).toContain("a.customer_id = v_customer_id");
    expect(file).not.toMatch(/'staff'\s*,\s*coalesce\(v_staff/);
    expect(file).toContain("NOTIFY pgrst, 'reload schema';");
    expect(file).toContain("ofoq: ✓");
    expect(file).toContain("ofoq: ✗");
    expect(file).toContain("has_function_privilege(");
    expect(file).toContain("ofoq_ensure_customer_profile");
    expect(file).toContain(migration.trim());
  });

  it("carries the same RPC body as migration 0010 and the generated setup bundle", () => {
    expect(functionDdl(file)).toBe(functionDdl(migration));
    expect(functionDdl(file)).toBe(functionDdl(bundle));
    expect(file.match(/CREATE OR REPLACE FUNCTION public\.ofoq_client_service_request\(/g)).toHaveLength(1);
  });

  it("carries the hardened client-dashboard replacement in the manual SQL", () => {
    // The manual copy stays at the 0010 hardening level …
    expect(dashboardDdl(file)).toBe(dashboardDdl(migration));
    expect(dashboardDdl(file)).toContain("o.status IN ('SENT', 'APPROVED', 'REJECTED')");
    expect(dashboardDdl(file)).not.toContain("o.status NOT IN ('CANCELLED', 'EXPIRED')");
  });

  it("keeps the offer hardening in the newest dashboard of the bundle (0011)", () => {
    // … while the generated bundle now carries the 0011 replacement, which adds
    // the project plan to the client dashboard and keeps the offer allowlist.
    expect(dashboardDdl(bundle)).toBe(dashboardDdl(projectPlanMigration));
    expect(dashboardDdl(bundle)).toContain("o.status IN ('SENT', 'APPROVED', 'REJECTED')");
    expect(dashboardDdl(bundle)).not.toContain("o.status NOT IN ('CANCELLED', 'EXPIRED')");
    expect(dashboardDdl(bundle)).toContain("public.project_plans");
  });
});
