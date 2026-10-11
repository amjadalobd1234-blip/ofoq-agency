import fs from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { ALERT_RPC_EXPECTATIONS, allAlertRpcsExposed, verifyAlertRpc, verifyAlertRpcs } from "../src/lib/admin/alert-rpc-contract";
import { parseRestSurface } from "../src/lib/supabase/postgrest-introspection";
import { diagnoseRpcFailure, rpcFailurePayload } from "../src/lib/supabase/rpc-diagnostics";
import { cookiesFromRequest, decodeJwtClaims, describeSession, projectRefFromSupabaseUrl, readAccessToken, readSessionCookie } from "../src/lib/supabase/session-diagnostics";
import type { SupabasePublicConfig } from "../src/lib/supabase/config";

/**
 * These tests cover the answer to «the RPC works in the SQL Editor but the staff
 * page says the migration is not installed». Nothing here talks to Supabase:
 * the classification, the cookie reading and the OpenAPI comparison are pure.
 *
 * The route-level test at the bottom runs the real GET handler with a mocked
 * session, so the log line the owner reads in Netlify/Cloudflare Function logs
 * is asserted too.
 */

const rootDir = process.cwd();
const middlewareSource = fs.readFileSync(path.join(rootDir, "src", "middleware.ts"), "utf8");
const detailRouteSource = fs.readFileSync(path.join(rootDir, "src", "app", "api", "admin", "alerts", "[id]", "route.ts"), "utf8");
const listRouteSource = fs.readFileSync(path.join(rootDir, "src", "app", "api", "admin", "alerts", "route.ts"), "utf8");
const alertMigration = fs.readFileSync(path.join(rootDir, "db", "migrations", "supabase", "0007_admin_alerts.sql"), "utf8");
const setupBundle = fs.readFileSync(path.join(rootDir, "docs", "setup", "supabase-setup.sql"), "utf8");

const CONFIG: SupabasePublicConfig = {
  url: "https://configrefrefrefref.supabase.co",
  anonKey: "anon-key",
  proxyUrl: null,
};

function base64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function fakeAccessToken(claims: Record<string, unknown>): string {
  return `${base64Url({ alg: "HS256", typ: "JWT" })}.${base64Url(claims)}.not-a-real-signature`;
}

function sessionCookieValue(tokens: { access_token?: string; refresh_token?: string }): string {
  return `base64-${Buffer.from(JSON.stringify(tokens)).toString("base64url")}`;
}

const COOKIE_NAME = "sb-configrefrefrefref-auth-token";

function requestWithCookies(cookies: Array<{ name: string; value: string }>, url = "http://localhost/api/admin/alerts/alert-1"): Request {
  return new Request(url, { headers: { cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ") } });
}

describe("session diagnostics", () => {
  it("decodes only the non-secret claims of an access token", () => {
    const token = fakeAccessToken({ ref: "toknrefrefrefref", role: "authenticated", sub: "d9352a7b-0000-0000-0000-000000000001", exp: 1_800_000_000, iss: "https://toknrefrefrefref.supabase.co/auth/v1" });
    expect(decodeJwtClaims(token)).toEqual({
      projectRef: "toknrefrefrefref",
      role: "authenticated",
      userId: "d9352a7b-0000-0000-0000-000000000001",
      issuedAt: null,
      expiresAt: 1_800_000_000,
      issuer: "https://toknrefrefrefref.supabase.co/auth/v1",
    });
    expect(decodeJwtClaims("not-a-jwt")).toBeNull();
  });

  it("reads a chunked @supabase/ssr cookie and reports a refresh-only session", () => {
    const value = sessionCookieValue({ access_token: fakeAccessToken({ ref: "toknrefrefrefref", sub: "user-1" }) });
    const first = value.slice(0, 20);
    const second = value.slice(20);
    const read = readSessionCookie(
      [
        { name: COOKIE_NAME, value: first },
        { name: `${COOKIE_NAME}.1`, value: second },
      ],
      COOKIE_NAME,
    );
    expect(read?.summary.chunks).toBe(2);
    expect(read?.summary.base64Prefixed).toBe(true);
    expect(read?.state?.claims?.projectRef).toBe("toknrefrefrefref");
    expect(read?.state?.refreshOnly).toBe(false);

    const refreshOnly = readSessionCookie([{ name: COOKIE_NAME, value: sessionCookieValue({ refresh_token: "rt-1" }) }], COOKIE_NAME);
    expect(refreshOnly?.state).toEqual({ hasAccessToken: false, hasRefreshToken: true, refreshOnly: true, claims: null });
  });

  it("keeps the raw access token out of the report but available for outbound calls", () => {
    const token = fakeAccessToken({ ref: "toknrefrefrefref", sub: "user-1" });
    const cookies = [{ name: COOKIE_NAME, value: sessionCookieValue({ access_token: token }) }];
    const report = describeSession(requestWithCookies(cookies), CONFIG, COOKIE_NAME);
    const serialised = JSON.stringify(report);
    expect(serialised).not.toContain(token);
    expect(serialised).not.toContain("base64-");
    expect(readAccessToken(cookies, COOKIE_NAME)).toBe(token);
  });

  it("names the project mismatch that makes a working RPC look missing", () => {
    const token = fakeAccessToken({ ref: "toknrefrefrefref", sub: "user-1" });
    const request = requestWithCookies([{ name: COOKIE_NAME, value: sessionCookieValue({ access_token: token }) }]);
    const report = describeSession(request, CONFIG, COOKIE_NAME);

    expect(report.hasExpectedAuthCookie).toBe(true);
    expect(report.cookieNames).toEqual([COOKIE_NAME]);
    expect(report.projectRef).toEqual({ fromSession: "toknrefrefrefref", fromConfigUrl: "configrefrefrefref", mismatch: true });
    expect(report.notes.join(" ")).toContain("the session belongs to project toknrefrefrefref");
    expect(projectRefFromSupabaseUrl("https://abcdefghijklmnop.supabase.co")).toBe("abcdefghijklmnop");
    expect(projectRefFromSupabaseUrl("not a url")).toBeNull();
  });

  it("explains an empty cookie jar instead of guessing", () => {
    const report = describeSession(new Request("http://localhost/api/me"), CONFIG, COOKIE_NAME);
    expect(report.cookieCount).toBe(0);
    expect(report.hasExpectedAuthCookie).toBe(false);
    expect(report.notes.join(" ")).toContain("no cookies at all");
    expect(cookiesFromRequest(new Request("http://localhost/", { headers: { cookie: "a=1; b=2" } }))).toEqual([
      { name: "a", value: "1" },
      { name: "b", value: "2" },
    ]);
  });
});

describe("RPC failure diagnosis", () => {
  const postgrestMessage = "Could not find the function public.ofoq_admin_alert_details(p_alert_id) in the schema cache";

  it("keeps the honest message for a genuinely missing migration", () => {
    const report = diagnoseRpcFailure({ code: "PGRST202", message: postgrestMessage }, { rpc: "ofoq_admin_alert_details", args: { p_alert_id: "<alert id>" } });
    expect(report).toMatchObject({ kind: "not_installed", code: "RPC_NOT_INSTALLED", status: 503 });
    expect(report.publicMessage).toBe("Supabase portal migration is not installed yet. Apply docs/setup/supabase-setup.sql in the Supabase SQL Editor.");
    expect(report.hint).toContain("NOTIFY pgrst, 'reload schema';");
    expect(report.hint).toContain("pg_get_function_arguments");
    expect(rpcFailurePayload(report, "req-1")).toMatchObject({ code: "RPC_NOT_INSTALLED", requestId: "req-1" });
  });

  it("blames the project mismatch first when the session is for another project", () => {
    const report = diagnoseRpcFailure(
      { code: "PGRST202", message: postgrestMessage },
      { rpc: "ofoq_admin_alert_details", sessionProjectRef: "toknrefrefrefref", configProjectRef: "configrefrefrefref" },
    );
    expect(report).toMatchObject({ kind: "wrong_project", code: "SESSION_PROJECT_MISMATCH", status: 503 });
    expect(report.hint).toContain("toknrefrefrefref");
  });

  it("separates a signature mismatch, a stale column, a permission and a missing table", () => {
    expect(diagnoseRpcFailure({ code: "42883", message: "function public.ofoq_admin_alert_details(p_id text) does not exist" }, { rpc: "ofoq_admin_alert_details" }))
      .toMatchObject({ kind: "signature_mismatch", code: "RPC_SIGNATURE_MISMATCH", status: 503 });
    expect(diagnoseRpcFailure({ code: "PGRST204", message: "Could not find the 'meta' column of 'alerts' in the schema cache" }, { rpc: "ofoq_admin_alerts" }))
      .toMatchObject({ kind: "stale_schema_cache", status: 503 });
    expect(diagnoseRpcFailure({ code: "42P01", message: 'relation "public.customers" does not exist' }, { rpc: "ofoq_admin_alert_details" }))
      .toMatchObject({ kind: "missing_table", status: 503 });
    expect(diagnoseRpcFailure({ code: "42501", message: "Staff access required" }, { rpc: "ofoq_admin_alerts" }))
      .toMatchObject({ kind: "permission_denied", status: 403, publicMessage: "You do not have permission for this data." });
  });

  it("maps the function's own error codes to the messages the portal already shows", () => {
    const cases: Array<[string, number, string]> = [
      ["28000", 401, "Your session is not active. Sign in again or contact the agency."],
      ["P0002", 404, "The requested record could not be found."],
      ["22023", 400, "The submitted data is invalid."],
      ["P0001", 429, "Please wait briefly before sending another message."],
      ["XX000", 502, "Unable to load platform data right now."],
    ];
    for (const [code, status, message] of cases) {
      const report = diagnoseRpcFailure({ code, message: "boom" }, { rpc: "ofoq_admin_alert_details" });
      expect(report.status).toBe(status);
      expect(report.publicMessage).toBe(message);
    }
  });
});

describe("Data API surface comparison", () => {
  it("reads RPC parameters from both OpenAPI shapes and ignores reserved ones", () => {
    const document = {
      swagger: "2.0",
      paths: {
        "/rpc/ofoq_admin_alert_details": {
          post: {
            parameters: [
              { name: "p_alert_id", type: "text", required: true },
              { name: "Prefer", in: "header", type: "string" },
            ],
          },
        },
        "/rpc/ofoq_admin_resolve_alert": {
          post: {
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    required: ["p_alert_id"],
                    properties: { p_alert_id: { format: "text" }, p_note: { format: "text" }, select: { format: "text" } },
                  },
                },
              },
            },
          },
        },
        "/alerts": { get: {} },
      },
    };
    const rpcs = parseRestSurface(document);
    expect([...rpcs.keys()].sort()).toEqual(["ofoq_admin_alert_details", "ofoq_admin_resolve_alert"]);
    expect(rpcs.get("ofoq_admin_alert_details")?.parameters.map((parameter) => parameter.name)).toEqual(["p_alert_id"]);
    expect(rpcs.get("ofoq_admin_resolve_alert")?.parameters.map((parameter) => parameter.name)).toEqual(["p_alert_id", "p_note"]);
  });

  it("distinguishes exposed, missing and wrongly-named functions", () => {
    const expectations = new Map(ALERT_RPC_EXPECTATIONS.map((expectation) => [expectation.name, expectation]));
    const detail = expectations.get("ofoq_admin_alert_details")!;
    const resolve = expectations.get("ofoq_admin_resolve_alert")!;
    const list = expectations.get("ofoq_admin_alerts")!;

    expect(verifyAlertRpc(detail, { name: detail.name, methods: ["POST"], parameters: [{ name: "p_alert_id", type: "text", required: true }] }, true))
      .toMatchObject({ status: "exposed", missingArgs: [] });
    expect(verifyAlertRpc(detail, null, true)).toMatchObject({ status: "missing" });
    expect(verifyAlertRpc(detail, null, false)).toMatchObject({ status: "unknown" });
    expect(verifyAlertRpc(resolve, { name: resolve.name, methods: ["POST"], parameters: [{ name: "p_alert_id", type: "text", required: true }] }, true))
      .toMatchObject({ status: "signature_mismatch", missingArgs: ["p_note"] });
    expect(verifyAlertRpc(list, { name: list.name, methods: ["POST"], parameters: [{ name: "p_status", type: "text", required: false }] }, true))
      .toMatchObject({ status: "signature_mismatch", missingArgs: ["p_limit", "p_offset"] });

    const surfaces = new Map(ALERT_RPC_EXPECTATIONS.map((expectation) => [expectation.name, { name: expectation.name, methods: ["POST"], parameters: expectation.args.map((arg) => ({ name: arg, type: "text", required: true })) }]));
    expect(allAlertRpcsExposed(verifyAlertRpcs(surfaces))).toBe(true);
    expect(allAlertRpcsExposed(verifyAlertRpcs(new Map()))).toBe(false);
  });
});

describe("wiring guards", () => {
  it("refreshes the session for the API routes the staff pages call", () => {
    const matcher = middlewareSource.slice(middlewareSource.indexOf("matcher:"));
    for (const entry of ['"/api/admin/:path*"', '"/api/me"', '"/api/dashboard"', '"/admin/:path*"']) {
      expect(middlewareSource).toContain("matcher: [");
      expect(matcher).toContain(entry);
    }
    // The proxy must never be matched: a Supabase round-trip per proxied call.
    expect(matcher).not.toContain("supabase-proxy");
  });

  it("hands the request to the auth helper and logs the session on failure", () => {
    expect(detailRouteSource).toContain("requireSupabaseUser(request)");
    expect(listRouteSource).toContain("requireSupabaseUser(request)");
    for (const source of [detailRouteSource, listRouteSource]) {
      expect(source).toContain("session: auth.session");
      expect(source).toContain("rpcError: {");
      expect(source).toContain("details:");
      expect(source).toContain("exposeHint: true");
    }
    expect(detailRouteSource).toContain("alertId: context.alertId");
    expect(detailRouteSource).toContain("userId: auth.user.id");
  });

  it("keeps the TypeScript contract identical to the SQL argument names", () => {
    for (const expectation of ALERT_RPC_EXPECTATIONS) {
      const start = alertMigration.indexOf(`CREATE OR REPLACE FUNCTION public.${expectation.name}(`);
      expect(start, `${expectation.name} must exist in ${expectation.sql}`).toBeGreaterThan(-1);
      const signature = alertMigration.slice(start, alertMigration.indexOf("RETURNS", start));
      for (const arg of expectation.args) {
        expect(signature, `${expectation.name} must declare ${arg}`).toMatch(new RegExp(`\\b${arg}\\s+(text|integer)`));
      }
      expect(expectation.sql).toContain("0007_admin_alerts.sql");
      // The one-shot SQL Editor bundle is generated from the same sources.
      expect(setupBundle).toContain(`FUNCTION public.${expectation.name}`);
    }
    expect(alertMigration).toContain("NOTIFY pgrst, 'reload schema';");
    expect(setupBundle).toContain("NOTIFY pgrst, 'reload schema';");
  });

  it("makes the migration self-healing for a signature that can never be called", () => {
    // PostgreSQL refuses CREATE OR REPLACE when an input parameter was renamed
    // (42P13) — the whole file would abort, leaving none of the five RPCs. The
    // pre-flight removes only the non-canonical overloads first.
    expect(alertMigration).toContain("pg_get_function_identity_arguments(p.oid) AS identity_args");
    expect(alertMigration).toContain("format('DROP FUNCTION public.%I(%s)', r.proname, r.identity_args)");
    expect(alertMigration).toContain("WHEN OTHERS THEN");
    expect(alertMigration).toContain("has_function_privilege('authenticated', p.oid, 'EXECUTE')");
    // The drop must key on proname: `regprocedure` prints the schema only when
    // the function happens to be in search_path, so matching on it is unsafe.
    expect(alertMigration).toContain("v_expected := CASE r.proname");
    // The bundle is generated from the migration, so it must carry the same text.
    expect(setupBundle).toContain("format('DROP FUNCTION public.%I(%s)', r.proname, r.identity_args)");
  });
});

describe("GET /api/admin/alerts/[id]", () => {
  const rpcMock = vi.fn();
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  beforeEach(() => {
    rpcMock.mockReset();
    errorSpy.mockClear();
    vi.resetModules();
  });

  async function importRoute(accessTokenClaims: Record<string, unknown>) {
    const token = fakeAccessToken(accessTokenClaims);
    vi.doMock("@/lib/supabase/route-auth", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../src/lib/supabase/route-auth")>();
      return {
        ...actual,
        requireSupabaseUser: async (request?: Request) => ({
          client: { rpc: rpcMock },
          user: { id: "user-1", email: "owner@example.test" },
          requestId: "test-request-id",
          session: describeSession(request ?? null, CONFIG, COOKIE_NAME),
          finalize: (response: Response) => response,
        }),
        requireOwnRole: async () => ({ profile: { id: "user-1", name: "أمجد", email: "owner@example.test", role: "OWNER", status: "ACTIVE", locale: "ar" } }),
      };
    });
    const route = await import("../src/app/api/admin/alerts/[id]/route");
    const cookie = sessionCookieValue({ access_token: token });
    const request = requestWithCookies([{ name: COOKIE_NAME, value: cookie }], "http://localhost/api/admin/alerts/28cd84e5-1111-2222-3333-444455556666");
    return { GET: route.GET, request };
  }

  const context = { params: Promise.resolve({ id: "28cd84e5-1111-2222-3333-444455556666" }) };

  it("returns the RPC payload and keeps the response no-store", async () => {
    const { GET, request } = await importRoute({ ref: "configrefrefrefref", sub: "user-1" });
    rpcMock.mockResolvedValue({ data: { alert: { id: "28cd84e5" } }, error: null });

    const response = await GET(request, context);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({ data: { alert: { id: "28cd84e5" } } });
    expect(rpcMock).toHaveBeenCalledWith("ofoq_admin_alert_details", { p_alert_id: "28cd84e5-1111-2222-3333-444455556666" });
  });

  it("answers with the migration hint, the machine code and one full log line", async () => {
    const { GET, request } = await importRoute({ ref: "configrefrefrefref", sub: "user-1" });
    const rpcError = {
      code: "PGRST202",
      message: "Could not find the function public.ofoq_admin_alert_details(p_alert_id) in the schema cache",
      details: null,
      hint: null,
    };
    rpcMock.mockResolvedValue({ data: null, error: rpcError });

    const response = await GET(request, context);
    const payload = await response.json();
    expect(response.status).toBe(503);
    expect(payload.code).toBe("RPC_NOT_INSTALLED");
    expect(payload.requestId).toBe("test-request-id");
    expect(payload.hint).toContain("/api/debug/alerts");

    // What the owner reads in the function logs.
    const logCall = errorSpy.mock.calls.find((call) => String(call[0]).includes("details RPC failed"));
    expect(logCall, "the route must log one line per failed RPC").toBeTruthy();
    const logged = logCall?.[1] as Record<string, unknown>;
    expect(logged).toMatchObject({ requestId: "test-request-id", action: "details", rpc: "ofoq_admin_alert_details" });
    expect(logged.alertId).toBe("28cd84e5-1111-2222-3333-444455556666");
    expect(logged.userId).toBe("user-1");
    expect(logged.rpcError).toEqual(rpcError);
    // Arguments are logged by name with redacted values — never a note or reply body.
    expect(logged.rpcArgs).toEqual({ p_alert_id: "<alert id>" });
    const session = logged.session as { cookieNames: string[]; projectRef: { mismatch: boolean } };
    expect(session.cookieNames).toEqual([COOKIE_NAME]);
    expect(session.projectRef.mismatch).toBe(false);

    // And the classification line written by rpcFailureResponse().
    const diagnosis = errorSpy.mock.calls.find((call) => String(call[0]).includes("ofoq_admin_alert_details failed"));
    expect(diagnosis).toBeTruthy();
    expect(String((diagnosis?.[1] as Record<string, unknown>).nextStep)).toContain("NOTIFY pgrst");
  });

  it("names the project mismatch when the cookie belongs to another Supabase project", async () => {
    const { GET, request } = await importRoute({ ref: "toknrefrefrefref", sub: "user-1" });
    rpcMock.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "Could not find the function public.ofoq_admin_alert_details(p_alert_id) in the schema cache" } });

    const response = await GET(request, context);
    const payload = await response.json();
    expect(response.status).toBe(503);
    expect(payload.code).toBe("SESSION_PROJECT_MISMATCH");
    const logged = errorSpy.mock.calls.find((call) => String(call[0]).includes("details RPC failed"))?.[1] as {
      session: { projectRef: { fromSession: string; fromConfigUrl: string } };
    };
    expect(logged.session.projectRef).toEqual({ fromSession: "toknrefrefrefref", fromConfigUrl: "configrefrefrefref", mismatch: true });
  });
});
