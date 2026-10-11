/**
 * End-to-end proof that the staff API routes really hand the browser's Supabase
 * session to the RPC — the exact question behind
 * «the RPC works in the SQL Editor but /admin/alerts says the migration is not
 * installed».
 *
 * Nothing here is mocked at the module level: the real route handler runs, the
 * real `@supabase/ssr` + `supabase-js` build the request, and a tiny HTTP server
 * stands in for the Supabase project. That server records what PostgREST would
 * have received, so the assertions are about the wire:
 *
 *   - `Authorization: Bearer <access token>` — the caller's own JWT, not `anon`
 *   - `apikey: <anon key>`
 *   - the RPC name and its named arguments
 *
 * The second half covers the refresh path: an expired access token is renewed
 * with the refresh token, the RPC runs with the new token, and the new session
 * is written back onto the API response so the browser keeps it.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getSupabaseAuthStorageKey, getSupabaseConfig } from "../src/lib/supabase/config";

const USER_ID = "d9352a7b-0000-0000-0000-000000000001";
const ACCESS_TOKEN = jwt({
  ref: "localproject",
  role: "authenticated",
  sub: USER_ID,
  exp: Math.floor(Date.now() / 1000) + 3600,
  iss: "http://127.0.0.1/auth/v1",
});
const REFRESHED_ACCESS_TOKEN = jwt({
  ref: "localproject",
  role: "authenticated",
  sub: USER_ID,
  exp: Math.floor(Date.now() / 1000) + 7200,
  iss: "http://127.0.0.1/auth/v1",
});
const EXPIRED_ACCESS_TOKEN = jwt({
  ref: "localproject",
  role: "authenticated",
  sub: USER_ID,
  exp: Math.floor(Date.now() / 1000) - 60,
  iss: "http://127.0.0.1/auth/v1",
});

const ALERT_ROWS = [
  {
    id: "28cd84e5-1111-2222-3333-444455556666",
    status: "ACKNOWLEDGED",
    titleAr: "عميل جديد يطلب تواصل",
    titleEn: "New client wants a call",
    severity: "URGENT",
    customerName: "امجد",
    customerEmail: "alobdali8@gmail.com",
  },
  {
    id: "a2a82a8f-1111-2222-3333-444455556666",
    status: "NEW",
    titleAr: "تصعيد دعم",
    titleEn: "Support escalation",
    severity: "HIGH",
    customerName: null,
    customerEmail: "client@example.test",
  },
];

/** One recorded PostgREST call: where it went and what it carried. */
interface Recorded {
  path: string;
  method: string;
  authorization: string | null;
  apikey: string | null;
  body: unknown;
}

const recorded: Recorded[] = [];
let server: http.Server;
let baseUrl = "";

function jwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(claims)}.test-signature`;
}

/**
 * The exact payload @supabase/ssr writes: `base64-` + base64url(JSON of the
 * auth-js session). `chunk` splits it the way the SDK does for large sessions.
 */
function sessionCookieValue(tokens: Record<string, unknown>, chunk = 0): string[] {
  const value = `base64-${Buffer.from(JSON.stringify(tokens)).toString("base64url")}`;
  if (chunk <= 0) return [value];
  const size = Math.ceil(value.length / chunk);
  return Array.from({ length: chunk }, (_, index) => value.slice(index * size, (index + 1) * size));
}

function session(tokens: { access_token?: string; refresh_token?: string; expiresIn?: number }) {
  return {
    access_token: tokens.access_token ?? null,
    refresh_token: tokens.refresh_token ?? "refresh-token-1",
    token_type: "bearer",
    expires_in: tokens.expiresIn ?? 3600,
    expires_at: Math.floor(Date.now() / 1000) + (tokens.expiresIn ?? 3600),
    user: { id: USER_ID, aud: "authenticated", role: "authenticated", email: "owner@ofoq.test" },
  };
}

/**
 * The `Cookie:` header the SDK produces: a single `name=value` when the session
 * fits, otherwise `name.0=…; name.1=…` — never a bare `name` alongside chunks.
 */
function cookieHeader(name: string, chunks: string[]): string {
  const names = chunks.length === 1 ? [name] : chunks.map((_, index) => `${name}.${index}`);
  return names.map((cookieName, index) => `${cookieName}=${chunks[index]}`).join("; ");
}

/** Cookie pairs for a session, chunked exactly the way @supabase/ssr writes them. */
function sessionCookies(tokens: Record<string, unknown>, chunk = 0): Array<{ name: string; value: string }> {
  const chunks = sessionCookieValue(tokens, chunk);
  const names = chunks.length === 1 ? [cookieName()] : chunks.map((_, index) => `${cookieName()}.${index}`);
  return names.map((name, index) => ({ name, value: chunks[index] }));
}

async function readBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  response.end(body);
}

beforeAll(async () => {
  server = http.createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", baseUrl || "http://127.0.0.1");
      const body = await readBody(request);

      // Auth: the SDK asks who this token belongs to.
      if (url.pathname === "/auth/v1/user") {
        const token = (request.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
        if (token !== ACCESS_TOKEN && token !== REFRESHED_ACCESS_TOKEN) {
          return sendJson(response, 401, { message: "invalid token" });
        }
        return sendJson(response, 200, {
          id: USER_ID,
          aud: "authenticated",
          role: "authenticated",
          email: "owner@ofoq.test",
          email_confirmed_at: "2026-10-01T00:00:00Z",
          app_metadata: { provider: "email", providers: ["email"] },
          user_metadata: {},
          created_at: "2026-10-01T00:00:00Z",
        });
      }

      // Auth: an expired token is exchanged for a new session.
      if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "refresh_token") {
        return sendJson(response, 200, {
          access_token: REFRESHED_ACCESS_TOKEN,
          refresh_token: "refresh-token-2",
          token_type: "bearer",
          expires_in: 7200,
          expires_at: Math.floor(Date.now() / 1000) + 7200,
          user: { id: USER_ID, aud: "authenticated", role: "authenticated", email: "owner@ofoq.test" },
        });
      }

      recorded.push({
        path: url.pathname,
        method: request.method ?? "GET",
        authorization: (request.headers.authorization as string | undefined) ?? null,
        apikey: (request.headers.apikey as string | undefined) ?? null,
        body: body ? safeJson(body) : null,
      });

      // The staff profile read the route performs before the alerts RPC.
      if (url.pathname === "/rest/v1/users") {
        return sendJson(response, 200, {
          id: USER_ID,
          name: "أمجد",
          email: "owner@ofoq.test",
          role: "OWNER",
          status: "ACTIVE",
          locale: "ar",
        });
      }

      if (url.pathname === "/rest/v1/rpc/ofoq_admin_alerts") {
        return sendJson(response, 200, { items: ALERT_ROWS, total: ALERT_ROWS.length, limit: 100, offset: 0 });
      }

      if (url.pathname === "/rest/v1/rpc/ofoq_admin_alert_details") {
        return sendJson(response, 200, { alert: ALERT_ROWS[0], conversation: null, messages: [] });
      }

      // The three staff actions return the refreshed alert, like the SQL does.
      if (
        url.pathname === "/rest/v1/rpc/ofoq_admin_acknowledge_alert" ||
        url.pathname === "/rest/v1/rpc/ofoq_admin_resolve_alert" ||
        url.pathname === "/rest/v1/rpc/ofoq_admin_reply_to_client"
      ) {
        return sendJson(response, 200, { alert: { ...ALERT_ROWS[0], status: "ACKNOWLEDGED" }, conversation: null, messages: [] });
      }

      return sendJson(response, 404, { message: `unexpected ${request.method} ${url.pathname}` });
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // Both the route client and the middleware read the project from the env.
  process.env.NEXT_PUBLIC_SUPABASE_URL = baseUrl;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  delete process.env.NEXT_PUBLIC_SUPABASE_PROXY_URL;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
});

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** The name this deployment reads, derived from the configured project URL. */
function cookieName(): string {
  return getSupabaseAuthStorageKey(getSupabaseConfig()!);
}

function requestFor(path: string, cookies: Array<{ name: string; value: string }>): Request {
  return new Request(`${baseUrl}${path}`, {
    headers: { cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ") },
  });
}

describe("GET /api/admin/alerts carries the session to the RPC", () => {
  it("sends the caller's JWT — not the anon key — with the list RPC", async () => {
    recorded.length = 0;
    const { GET } = await import("../src/app/api/admin/alerts/route");

    const response = await GET(requestFor("/api/admin/alerts?status=OPEN&limit=50", sessionCookies(session({ access_token: ACCESS_TOKEN }))));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: { items: ALERT_ROWS, total: ALERT_ROWS.length, limit: 100, offset: 0 } });

    const rpc = recorded.find((call) => call.path === "/rest/v1/rpc/ofoq_admin_alerts");
    expect(rpc, "the list RPC must be called").toBeTruthy();
    // The whole point: PostgREST answers as `authenticated`, so the
    // SECURITY DEFINER function (EXECUTE revoked from anon) is reachable.
    expect(rpc?.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(rpc?.apikey).toBe("anon-key");
    expect(rpc?.body).toEqual({ p_status: "OPEN", p_limit: 50, p_offset: 0 });
  });

  it("reads a chunked session cookie (.0/.1) the way the SDK writes it", async () => {
    recorded.length = 0;
    const { GET } = await import("../src/app/api/admin/alerts/route");
    const cookies = sessionCookies(session({ access_token: ACCESS_TOKEN }), 2);
    expect(cookies.length).toBeGreaterThan(1);
    expect(cookies.map((cookie) => cookie.name)).toEqual([`${cookieName()}.0`, `${cookieName()}.1`]);

    const response = await GET(requestFor("/api/admin/alerts", cookies));

    expect(response.status).toBe(200);
    expect(recorded.map((call) => call.path)).toContain("/rest/v1/rpc/ofoq_admin_alerts");
    expect(recorded.find((call) => call.path === "/rest/v1/rpc/ofoq_admin_alerts")?.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  it("passes the session to the details RPC and to the acknowledge action", async () => {
    recorded.length = 0;
    const { GET, POST } = await import("../src/app/api/admin/alerts/[id]/route");
    const cookies = sessionCookies(session({ access_token: ACCESS_TOKEN }));
    const context = { params: Promise.resolve({ id: "28cd84e5-1111-2222-3333-444455556666" }) };

    const detail = await GET(requestFor("/api/admin/alerts/28cd84e5-1111-2222-3333-444455556666", cookies), context);
    expect(detail.status).toBe(200);
    const detailsCall = recorded.find((call) => call.path === "/rest/v1/rpc/ofoq_admin_alert_details");
    expect(detailsCall?.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(detailsCall?.body).toEqual({ p_alert_id: "28cd84e5-1111-2222-3333-444455556666" });

    recorded.length = 0;
    const action = await POST(
      new Request(`${baseUrl}/api/admin/alerts/28cd84e5-1111-2222-3333-444455556666`, {
        method: "POST",
        headers: { cookie: cookieHeader(cookieName(), cookies.map((cookie) => cookie.value)), "content-type": "application/json" },
        body: JSON.stringify({ action: "acknowledge" }),
      }),
      context,
    );
    expect(action.status).toBe(200);
    expect(recorded.find((call) => call.path === "/rest/v1/rpc/ofoq_admin_acknowledge_alert")?.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  it("renews an expired access token and writes the new session onto the response", async () => {
    recorded.length = 0;
    const { GET } = await import("../src/app/api/admin/alerts/route");
    const response = await GET(requestFor("/api/admin/alerts", sessionCookies(session({ access_token: EXPIRED_ACCESS_TOKEN, expiresIn: -60 }))));

    expect(response.status).toBe(200);
    // The RPC ran with the freshly minted token, not the expired one.
    expect(recorded.find((call) => call.path === "/rest/v1/rpc/ofoq_admin_alerts")?.authorization).toBe(`Bearer ${REFRESHED_ACCESS_TOKEN}`);
    // …and the browser is told about it, so the next request is not stale again.
    const setCookie = response.headers.get("set-cookie");
    expect(setCookie, "the refreshed session must be set on the response").toContain(cookieName());
  });

  it("answers 401 without calling the RPC when no session cookie arrives", async () => {
    recorded.length = 0;
    const { GET } = await import("../src/app/api/admin/alerts/route");
    const response = await GET(requestFor("/api/admin/alerts", []));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(recorded.some((call) => call.path.startsWith("/rest/v1/rpc/"))).toBe(false);
  });
});
