/**
 * Issue 1 — «تعذر حفظ طلبك ❌ قاعدة البيانات ما زالت بلا حالة حفظ الطلبات».
 *
 * The client (and the sales team) apply `docs/setup/service-requests-migration.sql`
 * by hand in the Supabase SQL Editor, because the full bundle
 * (docs/setup/supabase-setup.sql) is not always what a project is missing: on
 * the live site the RPC `ofoq_client_service_request` alone was absent, and
 * every solved request ended in SERVICE_REQUEST_RPC_NOT_INSTALLED.
 *
 * So the standalone file must be a complete, self-contained fix:
 *
 *   1. it says how to apply it (Arabic steps, right at the top);
 *   2. it creates the RPC with the EXACT signature the app calls;
 *   3. it re-asserts RLS on the tables the RPC touches, and does not grant
 *      `anon` anything;
 *   4. it ends with `NOTIFY pgrst, 'reload schema'` plus a verification block
 *      that prints ✓/✗ — the two things that decide whether the client's next
 *      retry succeeds or keeps reporting a «missing» migration;
 *   5. its function body is byte-identical to 0008 and to the generated bundle,
 *      so applying it cannot install a second, diverging version of the RPC.
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const setupDir = path.join(process.cwd(), "docs", "setup");
const file = fs.readFileSync(path.join(setupDir, "service-requests-migration.sql"), "utf8");
const bundle = fs.readFileSync(path.join(setupDir, "supabase-setup.sql"), "utf8");
const migration = fs.readFileSync(
  path.join(process.cwd(), "db", "migrations", "supabase", "0008_service_requests.sql"),
  "utf8",
);

/** The RPC body, sliced the same way the PGlite execution test slices it. */
function functionDdl(source: string): string {
  const start = source.indexOf("CREATE OR REPLACE FUNCTION public.ofoq_client_service_request(");
  if (start < 0) throw new Error("the RPC is missing");
  const end = source.indexOf("$function$;", start);
  return source.slice(start, end + "$function$;".length);
}

describe("docs/setup/service-requests-migration.sql — the copy-paste fix for issue 1", () => {
  it("documents the apply steps and installs the RPC the app calls", () => {
    // The header is what the client reads in the SQL Editor: the steps, and why
    // the error message pointed at migration 0008.
    expect(file).toContain("خطوات التطبيق");
    expect(file).toContain("Supabase Dashboard");
    expect(file).toContain("SQL Editor");
    expect(file).toContain("0008");

    // The exact signature the route calls — PostgREST resolves it by name and
    // argument names, so a renamed or reordered argument is a PGRST202.
    expect(file).toContain("CREATE OR REPLACE FUNCTION public.ofoq_client_service_request(");
    for (const argument of [
      "p_request_id",
      "p_title_ar",
      "p_title_en",
      "p_body_ar",
      "p_body_en",
      "p_offer",
      "p_contact",
      "p_meta",
      "p_conversation_id",
      "p_locale",
    ]) {
      expect(file).toContain(argument);
    }
    // The resolved signature (five text + three jsonb + two text), spelled out
    // in the grants — the identity the Data API keys on.
    const signature = "public.ofoq_client_service_request(text, text, text, text, text, jsonb, jsonb, jsonb, text, text)";
    expect(file).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC, anon;`);
    expect(file).toContain(`GRANT EXECUTE ON FUNCTION ${signature} TO authenticated;`);
    expect(file).toContain("SECURITY DEFINER");
    expect(file).toContain("SET search_path = ''");
    // The saved shape the client sees and the alert the team reads.
    expect(file).toContain("'OFOQ-'");
    expect(file).toContain("'NEW_REQUEST'");
    expect(file).toContain("'IMPORTANT'");

    // RLS is re-asserted, never disabled, and the anonymous key gets nothing:
    // the write goes through the SECURITY DEFINER function, not the Data API.
    for (const table of ["offers", "alerts", "notifications", "activities", "conversations", "customers"]) {
      expect(file, `RLS on public.${table}`).toMatch(new RegExp(`ALTER TABLE public\\.${table}\\s+ENABLE ROW LEVEL SECURITY;`));
    }
    expect(file).toContain("REVOKE ALL ON FUNCTION public.ofoq_client_service_request(");
    expect(file).toContain("FROM PUBLIC, anon;");
    expect(file).toContain("TO authenticated;");
    expect(file).not.toMatch(/ALTER TABLE public\.\w+ DISABLE ROW LEVEL SECURITY/);
    expect(file).not.toMatch(/GRANT EXECUTE[^;]*TO anon/);

    // PostgREST's schema cache and the ✓/✗ report — the two things that make
    // «applied» mean «saving works from the site».
    expect(file).toContain("NOTIFY pgrst, 'reload schema';");
    expect(file).toContain("ofoq: ✓");
    expect(file).toContain("ofoq: ✗");
    expect(file).toContain("has_function_privilege('authenticated'");
    expect(file).toContain("ofoq_ensure_customer_profile");
  });

  it("carries the same RPC body as migration 0008 and the setup bundle", () => {
    // Byte-for-byte: the standalone fix may not drift from the real migration,
    // or «the file they applied» and «the file the tests execute» stop agreeing.
    expect(functionDdl(file)).toBe(functionDdl(migration));
    expect(functionDdl(file)).toBe(functionDdl(bundle));
    // One definition only — two `CREATE OR REPLACE` blocks in one file would
    // silently leave the last one installed.
    expect(file.match(/CREATE OR REPLACE FUNCTION public\.ofoq_client_service_request\(/g)).toHaveLength(1);
  });
});
