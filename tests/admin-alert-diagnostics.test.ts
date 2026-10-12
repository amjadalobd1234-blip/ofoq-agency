import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

/**
 * One spy for the whole file. `vi.spyOn(console, "error")` twice would install a
 * second mock on top of the first, and every call recorded by the first would
 * silently move to the second — so both suites share this one.
 */
const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

const rootDir = process.cwd();
const middlewareSource = fs.readFileSync(path.join(rootDir, "src", "middleware.ts"), "utf8");
const detailRouteSource = fs.readFileSync(path.join(rootDir, "src", "app", "api", "admin", "alerts", "[id]", "route.ts"), "utf8");
const listRouteSource = fs.readFileSync(path.join(rootDir, "src", "app", "api", "admin", "alerts", "route.ts"), "utf8");
const alertRouteLogSource = fs.readFileSync(path.join(rootDir, "src", "lib", "admin", "alert-route-log.ts"), "utf8");
/** The shared gate/logging module every alert action route runs through. */
const alertRouteGuardSource = fs.readFileSync(path.join(rootDir, "src", "lib", "admin", "alert-route-guard.ts"), "utf8");
const replyRouteSource = fs.readFileSync(path.join(rootDir, "src", "app", "api", "admin", "alerts", "[id]", "reply", "route.ts"), "utf8");
const resolveRouteSource = fs.readFileSync(path.join(rootDir, "src", "app", "api", "admin", "alerts", "[id]", "resolve", "route.ts"), "utf8");
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

  it("covers every session-reading API route in the middleware matcher", () => {
    // The session is only refreshed for the paths listed in config.matcher. A
    // route that reads a session but is not matched still receives cookies — it
    // just never gets a token refreshed, which is the «route-auth session
    // rejected / refreshOnly: true» line this whole investigation started from.
    const matcherEntries = [...middlewareSource.matchAll(/"(\/api\/[^"]*)"/g)].map((match) => match[1]);
    const covers = (routePath: string): boolean =>
      matcherEntries.some((entry) => {
        if (entry.endsWith("/:path*")) {
          const prefix = entry.slice(0, -"/:path*".length);
          return routePath === prefix || routePath.startsWith(`${prefix}/`);
        }
        return entry === routePath;
      });

    /** Documented exceptions: they accept work before a session exists. */
    const exempt = new Set(["/api/chat", "/api/ai/chat"]);

    const routes: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name === "route.ts") routes.push(full);
      }
    };
    walk(path.join(rootDir, "src", "app", "api"));

    const uncovered = routes
      // `requireStaffAccess(` counts too: the two dedicated alert action routes
      // read the session through the shared gate, and they must still be covered
      // by the matcher or a refresh never reaches them.
      .filter((file) => {
        const source = fs.readFileSync(file, "utf8");
        return source.includes("requireSupabaseUser(") || source.includes("requireStaffAccess(");
      })
      .map((file) => {
        const segments = path
          .relative(path.join(rootDir, "src", "app"), path.dirname(file))
          .split(path.sep)
          .filter((segment) => !segment.startsWith("(") || !segment.endsWith(")"))
          .map((segment) => (segment.startsWith("[") ? segment.replaceAll("[", "").replaceAll("]", "") : segment));
        return `/${segments.join("/")}`;
      })
      .filter((routePath) => !exempt.has(routePath) && !covers(routePath));

    expect(uncovered, "add these to src/middleware.ts config.matcher — or explain the exception above").toEqual([]);
    // The two staff endpoints this investigation is about are matched, too.
    expect(covers("/api/admin/alerts")).toBe(true);
    expect(covers("/api/admin/alerts/28cd84e5-1111-2222-3333-444455556666")).toBe(true);
    expect(covers("/api/admin/alerts/28cd84e5-1111-2222-3333-444455556666/reply")).toBe(true);
    expect(covers("/api/admin/alerts/28cd84e5-1111-2222-3333-444455556666/resolve")).toBe(true);
    expect(covers("/api/me")).toBe(true);
  });

  it("hands the request to the auth helper and logs the session on failure", () => {
    expect(listRouteSource).toContain("requireSupabaseUser(request)");
    // Every staff alert route — details, the action form and the two dedicated
    // action routes — runs through ONE gate, so a failure is logged identically
    // no matter which button caused it.
    for (const source of [detailRouteSource, replyRouteSource, resolveRouteSource]) {
      expect(source).toContain("requireStaffAccess(request,");
    }
    expect(alertRouteGuardSource).toContain("requireSupabaseUser(request)");
    // One log line per failure, in the same shape, from the same helper.
    expect(alertRouteGuardSource).toContain("logAdminAlertGateFailure(");
    expect(alertRouteGuardSource).toContain("logAdminAlertFailure(");
    expect(alertRouteGuardSource).toContain("exposeHint: true");
    expect(alertRouteGuardSource).toContain("alertId: context.alertId");
    // The four fields the log line must always carry (see alert-route-log.ts).
    for (const field of ["hasSession", "userId", "cookieCount", "rpcError", "cookieNames", "projectRef"]) {
      expect(alertRouteLogSource).toContain(field);
    }
    expect(alertRouteLogSource).toContain('console.error("[admin-alerts]"');
    // Session facts come from THIS request, never from an ambient cookie store.
    expect(alertRouteLogSource).toContain("describeRequestSession(");
    expect(alertRouteLogSource).toContain("safeDescribe(entry.request)");
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

/**
 * The failure paths the owner actually reads in the host's function logs.
 *
 * Three different problems all end with the same sentence in the page:
 * «Supabase portal migration is not installed yet». These tests pin what the
 * log says for each of them, so the sentence can always be traced to a cause:
 *
 *   - no session reached the route        → [admin-alerts] hasSession: false
 *   - public.users could not be read      → [admin-alerts] reason: "profile"
 *                                            (+ PROFILE_READ_FAILED, naming
 *                                             the table, NOT the alert RPC)
 *   - the RPC itself is not exposed       → [admin-alerts] reason: "rpc"
 */
describe("[admin-alerts] failure log", () => {
  const rpcMock = vi.fn();
  let profileResult: { data: unknown; error: unknown } = { data: null, error: null };

  beforeEach(() => {
    // A configured deployment, so the log helper reads the cookie the same way
    // the running app does (expected cookie name, claims, project refs).
    process.env.NEXT_PUBLIC_SUPABASE_URL = CONFIG.url;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = CONFIG.anonKey;
    rpcMock.mockReset();
    errorSpy.mockClear();
    profileResult = { data: null, error: null };
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  });

  /** A client whose profile read returns whatever the test set. */
  function fakeClient() {
    const chain = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: () => Promise.resolve(profileResult),
    };
    return { rpc: rpcMock, from: () => chain };
  }

  async function importListRoute(options: { session: boolean }) {
    vi.doMock("@/lib/supabase/route-auth", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../src/lib/supabase/route-auth")>();
      if (!options.session) {
        return {
          ...actual,
          requireSupabaseUser: async () =>
            ({ response: Response.json({ error: "Authentication required.", code: "AUTH_REQUIRED" }, { status: 401 }) }),
        };
      }
      // Everything else stays real — including requireOwnRole().
      return {
        ...actual,
        requireSupabaseUser: async (request?: Request) => ({
          client: fakeClient(),
          user: { id: "user-1", email: "owner@example.test" },
          requestId: "test-request-id",
          session: describeSession(request ?? null, CONFIG, COOKIE_NAME),
          finalize: (response: Response) => response,
        }),
      };
    });
    const route = await import("../src/app/api/admin/alerts/route");
    const cookie = sessionCookieValue({ access_token: fakeAccessToken({ ref: "configrefrefrefref", sub: "user-1" }) });
    return { GET: route.GET, request: requestWithCookies([{ name: COOKIE_NAME, value: cookie }], "http://localhost/api/admin/alerts?status=OPEN") };
  }

  function alertLog() {
    const call = errorSpy.mock.calls.find((entry) => entry[0] === "[admin-alerts]");
    expect(call, "every failure must write an [admin-alerts] line").toBeTruthy();
    return call?.[1] as Record<string, unknown>;
  }

  it("logs hasSession: false when no session reached the route", async () => {
    const { GET, request } = await importListRoute({ session: false });
    const response = await GET(request);

    expect(response.status).toBe(401);
    const logged = alertLog();
    expect(logged).toMatchObject({ route: "GET /api/admin/alerts", action: "list", reason: "auth_required", hasSession: false, userId: null, rpcError: null });
    expect(logged.cookieCount).toBe(1);
    // The cookie was there and named its user — the token itself was refused,
    // which is a different problem from «the browser sent no cookies».
    expect(logged.sessionUserId).toBe("user-1");
    expect(logged.hasExpectedAuthCookie).toBe(true);
    expect(String(logged.note)).toContain("[route-auth]");
  });

  it("names public.users — not the alert RPC — when the staff profile cannot be read", async () => {
    profileResult = {
      data: null,
      error: {
        code: "PGRST204",
        message: "Could not find the 'locale' column of 'users' in the schema cache",
        details: null,
        hint: null,
      },
    };
    const { GET, request } = await importListRoute({ session: true });
    const response = await GET(request);
    const payload = await response.json();

    // The page keeps a truthful message («something from the migration is
    // missing») but the machine code says which part, and the hint says where.
    expect(response.status).toBe(503);
    expect(payload.code).toBe("PROFILE_READ_FAILED");
    expect(payload.error).toContain("public.users");
    expect(payload.hint).toContain("schema cache");

    // …and the log line cannot be mistaken for a missing alert RPC.
    const logged = alertLog();
    expect(logged).toMatchObject({ reason: "profile", hasSession: true, userId: "user-1", rpc: "readOwnProfile" });
    expect(logged.cookieCount).toBe(1);
    expect(logged.rpcError).toMatchObject({ code: "PGRST204" });
    expect(String(logged.note)).toContain("not about ofoq_admin_alerts");

    // The classification line names the real resource and the real columns.
    const classified = errorSpy.mock.calls.find((entry) => String(entry[0]).includes("readOwnProfile failed"));
    const report = classified?.[1] as { explanation: string; nextStep: string; kind: string };
    expect(report.kind).toBe("stale_schema_cache");
    expect(report.explanation).toContain("public.users");
    expect(report.nextStep).toContain("public.users (id, name, email, role, status, locale)");

    // Nothing ever reached the alert RPC.
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("logs the RPC call, its arguments and the full PostgREST error when the list fails", async () => {
    profileResult = { data: { id: "user-1", name: "أمجد", email: "owner@example.test", role: "OWNER", status: "ACTIVE", locale: "ar" }, error: null };
    rpcMock.mockResolvedValue({
      data: null,
      error: { code: "PGRST202", message: "Could not find the function public.ofoq_admin_alerts(p_limit, p_offset, p_status) in the schema cache", details: null, hint: null },
    });
    const { GET, request } = await importListRoute({ session: true });
    const response = await GET(request);

    expect(response.status).toBe(503);
    const logged = alertLog();
    expect(logged).toMatchObject({
      reason: "rpc",
      hasSession: true,
      userId: "user-1",
      userRole: "OWNER",
      cookieCount: 1,
      rpc: "ofoq_admin_alerts",
      rpcArgs: { p_status: "OPEN", p_limit: "50", p_offset: "0" },
    });
    expect(logged.rpcError).toMatchObject({ code: "PGRST202" });
    // The cookie names and the project comparison travel with the same line.
    expect(logged.cookieNames).toEqual([COOKIE_NAME]);
    expect(logged.projectRef).toEqual({ fromSession: "configrefrefrefref", fromConfigUrl: "configrefrefrefref", mismatch: false });
  });
});
