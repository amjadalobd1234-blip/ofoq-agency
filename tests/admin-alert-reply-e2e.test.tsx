// @vitest-environment jsdom
/**
 * End-to-end reproduction of «صفحة تفاصيل التنبيه تفتح… لكن زر إرسال الرد ما
 * يستجيب».
 *
 * Nothing is stubbed at the module level: the real `AdminAlertDetail` component
 * renders, its `fetch()` calls are dispatched to the real Next.js route
 * handlers, and those handlers talk to a tiny HTTP server that behaves like the
 * Supabase Data API — including the one rule that decides whether a reply ever
 * reaches the database:
 *
 *   PostgREST resolves an RPC by NAME *and* PARAMETER NAMES. A call whose body
 *   carries different keys than the installed function answers
 *   PGRST202 «Could not find the function … in the schema cache».
 *
 * The server below enforces exactly that, so a mismatch fails here the same way
 * it fails in production, and the assertions are about what the staff member
 * sees and what the database would have received.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { getSupabaseAuthStorageKey, getSupabaseConfig } from "../src/lib/supabase/config";

const USER_ID = "d9352a7b-0000-0000-0000-000000000001";
const ALERT_ID = "28cd84e5-1111-2222-3333-444455556666";
const CONVERSATION_ID = "conv-0000-0000-0000-0000000000aa";

/** Every RPC call the fake Data API received: the argument names are the point. */
interface RecordedRpc {
  name: string;
  args: Record<string, unknown>;
  authorization: string | null;
}

const recorded: RecordedRpc[] = [];
let replyCount = 0;
/**
 * Reproduces the deployment problem behind «the button does nothing»: a project
 * where the function exists under DIFFERENT parameter names. PostgREST then
 * cannot resolve the call and answers PGRST202, exactly like production.
 */
let replyRpcSignatureMismatch = false;

/** The message rows the fake database holds — the E2E "check the DB" step. */
const clientMessage = {
  id: "msg-1",
  sender: "CLIENT",
  senderLabel: "امجد",
  body: "أرغب بالتحدث مع شخص",
  language: "ar",
  createdAt: "2026-10-12T04:00:00.000Z",
};
const messages: Array<Record<string, unknown>> = [clientMessage];
let alertStatus = "ACKNOWLEDGED";

/** Every test starts from the same alert, with no reply sent yet. */
function resetServerState(): void {
  messages.length = 0;
  messages.push({ ...clientMessage });
  alertStatus = "ACKNOWLEDGED";
  replyCount = 0;
}

let server: http.Server;
let baseUrl = "";
let sessionCookieHeader = "";

// `ref` matches the stub host (127.0.0.1 → project ref "127") so the session is
// never the reason a call fails — the tests are about the RPC contract itself.
const ACCESS_TOKEN = jwt({ ref: "127", role: "authenticated", sub: USER_ID, exp: Math.floor(Date.now() / 1000) + 3600 });

function jwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(claims)}.test-signature`;
}

function detailsPayload() {
  return {
    alert: {
      id: ALERT_ID,
      severity: "URGENT",
      category: "HUMAN_REQUEST",
      titleAr: "عميل جديد يطلب تواصل",
      titleEn: "New client wants a call",
      bodyAr: "العميل طلب فريق بشري",
      bodyEn: "The client asked for a human",
      status: alertStatus,
      createdAt: "2026-10-12T04:00:00.000Z",
      updatedAt: "2026-10-12T04:05:00.000Z",
      customerName: "امجد",
      customerEmail: "alobdali8@gmail.com",
      conversationId: CONVERSATION_ID,
      entityType: "conversation",
      entityId: CONVERSATION_ID,
      targetRole: "ANY_STAFF",
      acknowledgedAt: null,
      acknowledgedBy: null,
      resolvedAt: null,
      resolutionNote: null,
    },
    client: { id: "cust-1", name: "امجد", companyName: null, email: "alobdali8@gmail.com", phone: null },
    conversation: { id: CONVERSATION_ID, subject: "طلب جديد", status: "OPEN", lastMessageAt: "2026-10-12T04:00:00.000Z" },
    messages,
    activities: [],
  };
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

/** The keys the installed functions expect — i.e. what the app must send. */
const INSTALLED_ARGUMENTS: Record<string, string[]> = {
  ofoq_admin_alert_details: ["p_alert_id"],
  ofoq_admin_acknowledge_alert: ["p_alert_id"],
  ofoq_admin_reply_to_client: ["p_alert_id", "p_body", "p_language"],
  ofoq_admin_resolve_alert: ["p_alert_id", "p_note"],
};

function pgrst202(name: string, sent: string[], expected: string[]) {
  return {
    code: "PGRST202",
    message: `Could not find the function public.${name}(${sent.join(", ")}) in the schema cache`,
    details: `Searched for the function public.${name} with parameters ${sent.join(", ")}, but no matches were found in the schema cache.`,
    hint: `Perhaps you meant to call the function public.${name}(${expected.join(", ")})`,
  };
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

      const rpcMatch = /^\/rest\/v1\/rpc\/([A-Za-z0-9_]+)$/.exec(url.pathname);
      if (!rpcMatch) return sendJson(response, 404, { message: `unexpected ${request.method} ${url.pathname}` });

      const name = rpcMatch[1];
      const args = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      recorded.push({
        name,
        args,
        authorization: (request.headers.authorization as string | undefined) ?? null,
      });

      if (name === "ofoq_admin_reply_to_client" && replyRpcSignatureMismatch) {
        return sendJson(response, 404, pgrst202(name, Object.keys(args), ["p_conversation_id", "p_message", "p_locale"]));
      }

      const expectedArgs = INSTALLED_ARGUMENTS[name];
      if (!expectedArgs) return sendJson(response, 404, pgrst202(name, Object.keys(args), []));
      // PostgREST matches parameter NAMES: extra or renamed keys are a 202.
      const sentArgs = Object.keys(args);
      const unknown = sentArgs.filter((key) => !expectedArgs.includes(key));
      const missing = expectedArgs.filter((key) => !(key in args));
      if (unknown.length > 0 || missing.length > 0) {
        return sendJson(response, 404, pgrst202(name, sentArgs, expectedArgs));
      }

      if (name === "ofoq_admin_alert_details") return sendJson(response, 200, detailsPayload());

      if (name === "ofoq_admin_reply_to_client") {
        const text = typeof args.p_body === "string" ? args.p_body.trim() : "";
        if (!text || text.length > 5000) {
          return sendJson(response, 400, { code: "22023", message: "Reply must contain between 1 and 5000 characters", details: null, hint: null });
        }
        replyCount += 1;
        messages.push({
          id: `msg-reply-${replyCount}`,
          sender: "STAFF",
          senderLabel: "أمجد",
          body: text,
          language: args.p_language === "en" ? "en" : "ar",
          createdAt: "2026-10-12T04:10:00.000Z",
        });
        alertStatus = "ACKNOWLEDGED";
        return sendJson(response, 200, detailsPayload());
      }

      if (name === "ofoq_admin_acknowledge_alert") {
        alertStatus = "ACKNOWLEDGED";
        return sendJson(response, 200, detailsPayload());
      }

      if (name === "ofoq_admin_resolve_alert") {
        alertStatus = "RESOLVED";
        return sendJson(response, 200, detailsPayload());
      }

      return sendJson(response, 404, { message: `unhandled rpc ${name}` });
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
  sessionCookieHeader = `${cookieName}=base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;

  // The browser half of the flow: relative URLs resolve to this app, and the
  // session cookie rides along exactly as a browser would send it.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(target, "http://localhost");
    if (!url.pathname.startsWith("/api/")) return originalFetch(input as RequestInfo, init);

    const { dispatchApiRequest } = await import("./helpers/api-bridge");
    return dispatchApiRequest(url, init, sessionCookieHeader);
  }) as typeof fetch;
});

const originalFetch = globalThis.fetch;

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
});

afterEach(() => {
  cleanup();
  recorded.length = 0;
  replyRpcSignatureMismatch = false;
  resetServerState();
});

describe("staff reply E2E", () => {
  it("shows the alert details and its conversation", async () => {
    const { AdminAlertDetail } = await import("../src/components/admin-alert-detail");
    render(<AdminAlertDetail alertId={ALERT_ID} locale="ar" />);

    await waitFor(() => expect(screen.getByText("عميل جديد يطلب تواصل")).toBeTruthy());
    expect(screen.getByText("أرغب بالتحدث مع شخص")).toBeTruthy();
    const composer = await screen.findByLabelText("الرد على العميل");
    expect(composer).toBeTruthy();
  });

  it("sends the reply, shows success, clears the box and stores a STAFF message", async () => {
    const { AdminAlertDetail } = await import("../src/components/admin-alert-detail");
    render(<AdminAlertDetail alertId={ALERT_ID} locale="ar" />);

    const composer = (await screen.findByLabelText("الرد على العميل")) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "شكرًا لتواصلك، سنتصل بك اليوم." } });

    const send = screen.getByRole("button", { name: "إرسال الرد" }) as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    fireEvent.click(send);

    // The staff member's own confirmation, next to the button they pressed.
    const confirmation = await screen.findByRole("status");
    expect(confirmation.textContent).toContain("تم الإرسال بنجاح");

    const rpc = recorded.find((call) => call.name === "ofoq_admin_reply_to_client");
    expect(rpc, "the reply RPC must reach the Data API").toBeTruthy();
    expect(rpc?.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(rpc?.args).toEqual({ p_alert_id: ALERT_ID, p_body: "شكرًا لتواصلك، سنتصل بك اليوم.", p_language: "ar" });

    // The row the SQL inserts — sender_type = 'STAFF'.
    const staffMessage = messages.find((message) => message.sender === "STAFF");
    expect(staffMessage?.body).toBe("شكرًا لتواصلك، سنتصل بك اليوم.");
    await waitFor(() => expect((screen.getByLabelText("الرد على العميل") as HTMLTextAreaElement).value).toBe(""));
  });

  it("resolves the alert through its own endpoint and confirms it", async () => {
    const { AdminAlertDetail } = await import("../src/components/admin-alert-detail");
    render(<AdminAlertDetail alertId={ALERT_ID} locale="ar" />);

    const note = (await screen.findByLabelText("ملاحظة الحل (اختياري)")) as HTMLTextAreaElement;
    fireEvent.change(note, { target: { value: "تم الاتصال بالعميل." } });
    fireEvent.click(screen.getByRole("button", { name: "تم الحل" }));

    await waitFor(() => expect(screen.getByText(/تم الحل بنجاح/)).toBeTruthy());

    const rpc = recorded.find((call) => call.name === "ofoq_admin_resolve_alert");
    expect(rpc?.args).toEqual({ p_alert_id: ALERT_ID, p_note: "تم الاتصال بالعميل." });
    // The page re-renders from the RPC's payload: RESOLVED disables the composer
    // and explains why, without a reload.
    await waitFor(() => expect(screen.getByText(/تم إغلاق التنبيه/)).toBeTruthy());
    expect((screen.getByRole("button", { name: "إرسال الرد" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/لا يمكن الرد بعد حل التنبيه/)).toBeTruthy();
    expect(alertStatus).toBe("RESOLVED");
  });

  it("shows the API error and keeps the typed text when the RPC arguments do not match", async () => {
    replyRpcSignatureMismatch = true;
    const { AdminAlertDetail } = await import("../src/components/admin-alert-detail");
    render(<AdminAlertDetail alertId={ALERT_ID} locale="ar" />);

    const composer = (await screen.findByLabelText("الرد على العميل")) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "رد لن يستطيع الـ API حل الدالة معه." } });
    fireEvent.click(screen.getByRole("button", { name: "إرسال الرد" }));

    // «ما يستجيب» is over: the click now produces a visible, actionable answer.
    const failure = await screen.findByRole("alert");
    expect(failure.textContent).toContain("تعذر تنفيذ الإجراء");
    // The machine code the owner searches the logs with, plus the API's own hint.
    expect(failure.textContent).toContain("RPC_NOT_INSTALLED");
    // …and a next step the staff member can actually follow from the page.
    expect(failure.textContent).toContain("/api/debug/alerts");
    // …and the typing is not lost, so the reply can be sent once the SQL is applied.
    expect((screen.getByLabelText("الرد على العميل") as HTMLTextAreaElement).value).toBe("رد لن يستطيع الـ API حل الدالة معه.");
    expect(messages.some((message) => message.sender === "STAFF")).toBe(false);
  });

  it("acknowledges the alert from the button and confirms it above the card", async () => {
    alertStatus = "NEW";
    const { AdminAlertDetail } = await import("../src/components/admin-alert-detail");
    render(<AdminAlertDetail alertId={ALERT_ID} locale="ar" />);

    fireEvent.click(await screen.findByRole("button", { name: "تأكيد المتابعة" }));

    await waitFor(() => expect(screen.getByText(/تم تسجيل متابعتك للتنبيه/)).toBeTruthy());
    // The status pill follows the payload the RPC returned.
    expect(screen.getAllByText("قيد المتابعة").length).toBeGreaterThan(0);
    expect(alertStatus).toBe("ACKNOWLEDGED");
  });

  it("keeps the one-endpoint form working for a tab that loaded the previous bundle", async () => {
    const { dispatchApiRequest } = await import("./helpers/api-bridge");
    const response = await dispatchApiRequest(
      new URL(`http://localhost/api/admin/alerts/${ALERT_ID}`),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "reply", body: "من الحزمة القديمة.", language: "ar" }),
      },
      sessionCookieHeader,
    );

    expect(response.status).toBe(200);
    const rpc = recorded.find((call) => call.name === "ofoq_admin_reply_to_client");
    expect(rpc?.args).toEqual({ p_alert_id: ALERT_ID, p_body: "من الحزمة القديمة.", p_language: "ar" });
  });
});
