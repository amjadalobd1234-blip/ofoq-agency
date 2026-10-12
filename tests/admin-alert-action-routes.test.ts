/**
 * The two dedicated alert-action endpoints, exercised as HTTP.
 *
 * `POST /api/admin/alerts/[id]/reply` and `…/[id]/resolve` are the routes the
 * staff page's buttons call. What is asserted here is the contract that decides
 * whether a click reaches the database:
 *
 *   - the RPC NAME and the argument NAMES (PostgREST resolves a function by
 *     both, so a renamed parameter is a PGRST202, not a working button),
 *   - the caller's own JWT (never the anon key) on the Data API request,
 *   - a machine code on every refusal, so the component can explain itself,
 *   - and «no RPC call at all» for input the server can reject on its own.
 *
 * The Supabase project is a local HTTP server: the real route handlers run, the
 * real `@supabase/ssr` builds the requests, and the assertions are about the
 * wire.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { getSupabaseAuthStorageKey, getSupabaseConfig } from "../src/lib/supabase/config";

const USER_ID = "d9352a7b-0000-0000-0000-000000000001";
const ALERT_ID = "28cd84e5-1111-2222-3333-444455556666";
const ACCESS_TOKEN = jwt({ ref: "127", role: "authenticated", sub: USER_ID, exp: Math.floor(Date.now() / 1000) + 3600 });

interface Recorded {
  path: string;
  method: string;
  authorization: string | null;
  apikey: string | null;
  body: unknown;
}

const recorded: Recorded[] = [];
/** Set per test: which RPC names the fake Data API answers 404 PGRST202 for. */
const unexposedRpcs = new Set<string>();
/** Set per test: the role the profile read returns. */
let profileRole = "OWNER";
let profileStatus = "ACTIVE";

let server: http.Server;
let baseUrl = "";
let cookies: Array<{ name: string; value: string }> = [];

function jwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(claims)}.test-signature`;
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
      const raw = await readBody(request);

      if (url.pathname === "/auth/v1/user") {
        const token = (request.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
        if (token !== ACCESS_TOKEN) return sendJson(response, 401, { message: "invalid token" });
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

      recorded.push({
        path: url.pathname,
        method: request.method ?? "GET",
        authorization: (request.headers.authorization as string | undefined) ?? null,
        apikey: (request.headers.apikey as string | undefined) ?? null,
        body: raw ? (JSON.parse(raw) as unknown) : null,
      });

      if (url.pathname === "/rest/v1/users") {
        return sendJson(response, 200, {
          id: USER_ID,
          name: "أمجد",
          email: "owner@ofoq.test",
          role: profileRole,
          status: profileStatus,
          locale: "ar",
        });
      }

      const rpc = /^\/rest\/v1\/rpc\/([A-Za-z0-9_]+)$/.exec(url.pathname)?.[1];
      if (rpc && unexposedRpcs.has(rpc)) {
        return sendJson(response, 404, {
          code: "PGRST202",
          message: `Could not find the function public.${rpc}(p_conversation_id, p_message, p_locale) in the schema cache`,
          details: null,
          hint: null,
        });
      }
      // A real project refuses the nil alert id with P0002 before writing —
      // the diagnostics call that answer «the argument names resolve».
      if (rpc && (rpc === "ofoq_admin_reply_to_client" || rpc === "ofoq_admin_resolve_alert")) {
        const args = raw ? (JSON.parse(raw) as { p_alert_id?: string }) : {};
        if (args.p_alert_id === "00000000-0000-0000-0000-000000000000") {
          return sendJson(response, 400, {
            code: "P0002",
            message: rpc === "ofoq_admin_reply_to_client" ? "Alert is not linked to a client conversation" : "Alert not found",
            details: null,
            hint: null,
          });
        }
      }
      if (rpc) return sendJson(response, 200, { alert: { id: ALERT_ID, status: "ACKNOWLEDGED" }, messages: [], activities: [] });

      return sendJson(response, 404, { message: `unexpected ${request.method} ${url.pathname}` });
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.NEXT_PUBLIC_SUPABASE_URL = baseUrl;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  delete process.env.NEXT_PUBLIC_SUPABASE_PROXY_URL;

  const cookieName = getSupabaseAuthStorageKey(getSupabaseConfig()!);
  const session = {
    access_token: ACCESS_TOKEN,
    refresh_token: "refresh-token-1",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: USER_ID, aud: "authenticated", role: "authenticated", email: "owner@ofoq.test" },
  };
  cookies = [{ name: cookieName, value: `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}` }];
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
});

afterEach(() => {
  recorded.length = 0;
  unexposedRpcs.clear();
  profileRole = "OWNER";
  profileStatus = "ACTIVE";
});

const context = { params: Promise.resolve({ id: ALERT_ID }) };

function post(path: string, payload: unknown, options: { session?: boolean } = {}): Request {
  const cookie = options.session === false ? "" : cookies.map((entry) => `${entry.name}=${entry.value}`).join("; ");
  return new Request(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(payload),
  });
}

function rpcCall(name: string): Recorded | undefined {
  return recorded.find((call) => call.path === `/rest/v1/rpc/${name}`);
}

describe("POST /api/admin/alerts/[id]/reply", () => {
  it("sends the caller's session to ofoq_admin_reply_to_client with the exact argument names", async () => {
    const { POST } = await import("../src/app/api/admin/alerts/[id]/reply/route");
    const response = await POST(post(`/api/admin/alerts/${ALERT_ID}/reply`, { body: "أهلًا بك", language: "en" }), context);

    expect(response.status).toBe(200);
    const call = rpcCall("ofoq_admin_reply_to_client");
    expect(call, "the reply RPC must be called").toBeTruthy();
    expect(call?.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(call?.apikey).toBe("anon-key");
    // The three names the SQL declares, in the shape PostgREST resolves.
    expect(call?.body).toEqual({ p_alert_id: ALERT_ID, p_body: "أهلًا بك", p_language: "en" });
  });

  it("accepts the RPC's own argument names and the `message` alias", async () => {
    const { POST } = await import("../src/app/api/admin/alerts/[id]/reply/route");
    await POST(post(`/api/admin/alerts/${ALERT_ID}/reply`, { p_body: "  من الوسيط p_body  ", p_language: "ar" }), context);
    expect(rpcCall("ofoq_admin_reply_to_client")?.body).toEqual({ p_alert_id: ALERT_ID, p_body: "من الوسيط p_body", p_language: "ar" });

    recorded.length = 0;
    await POST(post(`/api/admin/alerts/${ALERT_ID}/reply`, { message: "من الوسيط message" }), context);
    expect(rpcCall("ofoq_admin_reply_to_client")?.body).toEqual({ p_alert_id: ALERT_ID, p_body: "من الوسيط message", p_language: "ar" });
  });

  it("refuses an empty or oversized reply without calling the database", async () => {
    const { POST } = await import("../src/app/api/admin/alerts/[id]/reply/route");

    const empty = await POST(post(`/api/admin/alerts/${ALERT_ID}/reply`, { body: "   " }), context);
    expect(empty.status).toBe(400);
    await expect(empty.json()).resolves.toMatchObject({ code: "INVALID_REPLY_BODY" });

    const oversized = await POST(post(`/api/admin/alerts/${ALERT_ID}/reply`, { body: "x".repeat(5_001) }), context);
    expect(oversized.status).toBe(400);
    await expect(oversized.json()).resolves.toMatchObject({ code: "INVALID_REPLY_BODY" });

    const notText = await POST(post(`/api/admin/alerts/${ALERT_ID}/reply`, { body: 42 }), context);
    expect(notText.status).toBe(400);

    expect(recorded.some((call) => call.path.startsWith("/rest/v1/rpc/"))).toBe(false);
  });

  it("answers 401 without a session and 403 for a non-staff account", async () => {
    const { POST } = await import("../src/app/api/admin/alerts/[id]/reply/route");

    const anonymous = await POST(post(`/api/admin/alerts/${ALERT_ID}/reply`, { body: "مرحبا" }, { session: false }), context);
    expect(anonymous.status).toBe(401);
    await expect(anonymous.json()).resolves.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(rpcCall("ofoq_admin_reply_to_client")).toBeFalsy();

    recorded.length = 0;
    profileRole = "CLIENT";
    const notStaff = await POST(post(`/api/admin/alerts/${ALERT_ID}/reply`, { body: "مرحبا" }), context);
    expect(notStaff.status).toBe(403);
    expect(rpcCall("ofoq_admin_reply_to_client")).toBeFalsy();
  });

  it("reports a missing/mismatched RPC as RPC_NOT_INSTALLED instead of failing silently", async () => {
    unexposedRpcs.add("ofoq_admin_reply_to_client");
    const { POST } = await import("../src/app/api/admin/alerts/[id]/reply/route");
    const response = await POST(post(`/api/admin/alerts/${ALERT_ID}/reply`, { body: "مرحبا" }), context);

    expect(response.status).toBe(503);
    const payload = (await response.json()) as { code: string; hint?: string; requestId?: string };
    expect(payload.code).toBe("RPC_NOT_INSTALLED");
    // The next step a staff member (or their developer) can follow immediately.
    expect(payload.hint).toContain("/api/debug/alerts");
    expect(payload.requestId).toBeTruthy();
  });

  it("rejects a malformed alert id before any RPC runs", async () => {
    const { POST } = await import("../src/app/api/admin/alerts/[id]/reply/route");
    const response = await POST(post("/api/admin/alerts//reply", { body: "مرحبا" }), { params: Promise.resolve({ id: "   " }) });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "INVALID_ALERT_ID" });
    expect(recorded.some((call) => call.path.startsWith("/rest/v1/rpc/"))).toBe(false);
  });
});

describe("POST /api/admin/alerts/[id]/resolve", () => {
  it("sends the note to ofoq_admin_resolve_alert and accepts an empty one", async () => {
    const { POST } = await import("../src/app/api/admin/alerts/[id]/resolve/route");

    const withNote = await POST(post(`/api/admin/alerts/${ALERT_ID}/resolve`, { note: "تم الاتصال" }), context);
    expect(withNote.status).toBe(200);
    expect(rpcCall("ofoq_admin_resolve_alert")?.body).toEqual({ p_alert_id: ALERT_ID, p_note: "تم الاتصال" });

    recorded.length = 0;
    const withoutNote = await POST(post(`/api/admin/alerts/${ALERT_ID}/resolve`, {}), context);
    expect(withoutNote.status).toBe(200);
    // `null`, exactly as the RPC's `p_note text DEFAULT NULL` expects.
    expect(rpcCall("ofoq_admin_resolve_alert")?.body).toEqual({ p_alert_id: ALERT_ID, p_note: null });
  });

  it("bounds the note the same way the SQL does", async () => {
    const { POST } = await import("../src/app/api/admin/alerts/[id]/resolve/route");
    const response = await POST(post(`/api/admin/alerts/${ALERT_ID}/resolve`, { note: "x".repeat(2_001) }), context);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "INVALID_RESOLUTION_NOTE" });
    expect(recorded.some((call) => call.path.startsWith("/rest/v1/rpc/"))).toBe(false);
  });

  it("classifies a signature mismatch for the resolve RPC too", async () => {
    unexposedRpcs.add("ofoq_admin_resolve_alert");
    const { POST } = await import("../src/app/api/admin/alerts/[id]/resolve/route");
    const response = await POST(post(`/api/admin/alerts/${ALERT_ID}/resolve`, { note: "تم" }), context);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: "RPC_NOT_INSTALLED" });
  });

});

describe("GET /api/debug/alerts action probes", () => {
  it("reports both write actions as ready on a healthy project, and explains the disabled button", async () => {
    const { GET } = await import("../src/app/api/debug/alerts/route");
    const response = await GET(new Request(`${baseUrl}/api/debug/alerts?alertId=${ALERT_ID}`, {
      headers: { cookie: cookies.map((entry) => `${entry.name}=${entry.value}`).join("; ") },
    }));
    const payload = (await response.json()) as {
      actionProbes: { written: boolean; probeAlertId: string; reply: { status: string; args: string[] }; resolve: { status: string } };
      replyability: { replyable: boolean; reason: string } | null;
      nextSteps: string[];
    };

    expect(payload.actionProbes.written).toBe(false);
    expect(payload.actionProbes.probeAlertId).toBe("00000000-0000-0000-0000-000000000000");
    expect(payload.actionProbes.reply.status).toBe("ready");
    expect(payload.actionProbes.reply.args).toEqual(["p_alert_id", "p_body", "p_language"]);
    expect(payload.actionProbes.resolve.status).toBe("ready");
    expect(payload.replyability).not.toBeNull();
  });

  it("names the fix when the reply RPC is not exposed with those argument names", async () => {
    unexposedRpcs.add("ofoq_admin_reply_to_client");
    const { GET } = await import("../src/app/api/debug/alerts/route");
    const response = await GET(new Request(`${baseUrl}/api/debug/alerts?alertId=${ALERT_ID}`, {
      headers: { cookie: cookies.map((entry) => `${entry.name}=${entry.value}`).join("; ") },
    }));
    const payload = (await response.json()) as {
      ok: boolean;
      actionProbes: { reply: { status: string; detail: { ar: string; en: string }; hint: string } };
      nextSteps: string[];
    };

    expect(payload.actionProbes.reply.status).toBe("not_exposed");
    expect(payload.actionProbes.reply.hint).toContain("0007_admin_alerts.sql");
    expect(payload.nextSteps.join(" ")).toContain("reply:");
    expect(payload.ok).toBe(false);
  });
});
