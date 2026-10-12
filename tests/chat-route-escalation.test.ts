import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_OWNER_EMAIL } from "../src/lib/services/escalation.service";

/**
 * End-to-end wiring of POST /api/chat.
 *
 * This is the route the client portal chat calls. The test replaces only the
 * Supabase transport (a fake RPC client) and the network (a fake fetch for
 * Resend), so everything in between — language detection, the assistant reply,
 * the escalation decision, the alert write, the owner email and the reply that
 * is saved — is the real code path.
 */

interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}

const calls: RpcCall[] = [];
let escalateResponse: { data: unknown; error: { code: string; message: string } | null };
/** The conversation the RPC hands back; each test sets the context it needs. */
let history: Array<{ role: string; content: string }> = [];
let latestMessage = "";
/** What `ofoq_client_chat_bootstrap` returns for the signed-in client. */
let bootstrapPayload: Record<string, unknown> = {};

function fakeSupabaseClient() {
  return {
    rpc(fn: string, args?: Record<string, unknown>) {
      calls.push({ fn, args: (args ?? {}) as Record<string, unknown> });
      if (fn === "ofoq_client_chat_send") {
        return Promise.resolve({
          data: {
            conversationId: "conv-1",
            customerName: "نور",
            language: "ar",
            messages: history,
            userMessage: {
              id: "msg-1",
              sender: "CLIENT",
              body: latestMessage,
              language: "ar",
              createdAt: "2026-01-01T10:00:00.000Z",
            },
          },
          error: null,
        });
      }
      if (fn === "ofoq_client_chat_reply") {
        return Promise.resolve({
          data: {
            id: "msg-2",
            sender: "ASSISTANT",
            body: args?.p_body,
            language: args?.p_language ?? "ar",
            createdAt: "2026-01-01T10:00:05.000Z",
            provider: args?.p_provider ?? "rules",
          },
          error: null,
        });
      }
      if (fn === "ofoq_client_chat_bootstrap") return Promise.resolve({ data: bootstrapPayload, error: null });
      if (fn === "ofoq_client_escalate") return Promise.resolve(escalateResponse);
      return Promise.resolve({ data: { updated: 1 }, error: null });
    },
    from(table: string) {
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: () =>
          Promise.resolve(
            table === "customers" ? { data: { id: "customer-1" }, error: null } : { data: null, error: null },
          ),
      };
      return builder;
    },
  };
}

/** The platform profile of the signed-in account, as /api/chat reads it. */
let ownProfile: { id: string; role: string; status: string } | null = {
  id: "user-1",
  role: "CLIENT",
  status: "ACTIVE",
};

vi.mock("@/lib/supabase/route-auth", () => ({
  requireSupabaseUser: () =>
    Promise.resolve({ client: fakeSupabaseClient(), user: { id: "user-1", email: "client@example.test" } }),
  rpcFailureResponse: (error: { message?: string }) =>
    Response.json({ error: error?.message ?? "rpc failed" }, { status: 502 }),
  fetchOwnProfile: () =>
    Promise.resolve(
      ownProfile
        ? { profile: { ...ownProfile, name: "نور", email: "client@example.test", locale: "ar" } }
        : { error: { code: "NO_PROFILE", message: "No platform profile for this account." } },
    ),
}));

const { GET, POST } = await import("../src/app/api/chat/route");

function postRequest(message: string): Request {
  latestMessage = message;
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
}

const resendOk = () =>
  new Response(JSON.stringify({ id: "email-1" }), { status: 200, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  calls.length = 0;
  history = [
    { role: "user", content: "أحتاج حملة إعلانية لمتجري على إنستغرام" },
    { role: "assistant", content: "ما الهدف من الحملة؟" },
  ];
  latestMessage = "أريد أتكلم مع بشري";
  bootstrapPayload = {
    conversationId: "conv-1",
    customerName: "نور",
    email: "client@example.test",
    language: "ar",
    messages: [{ id: "msg-0", sender: "ASSISTANT", body: "أهلًا بك في أفق", language: "ar", createdAt: "2026-01-01T09:00:00.000Z" }],
  };
  escalateResponse = {
    data: {
      alertId: "alert-1",
      created: true,
      severity: "URGENT",
      category: "HUMAN_REQUEST",
      conversationId: "conv-1",
      conversationStatus: "PENDING",
      clientName: "نور",
      clientEmail: "client@example.test",
      staff: [{ id: "owner-1", email: "owner@example.test", name: "Owner" }],
    },
    error: null,
  };
  vi.stubEnv("RESEND_API_KEY", "re_test_key");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(resendOk()));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("POST /api/chat escalation", () => {
  it("turns «أريد أتكلم مع بشري» into an alert, an owner email and an honest reply", async () => {
    const response = await POST(postRequest("أريد أتكلم مع بشري"));
    const payload = (await response.json()) as {
      data: {
        escalated: boolean;
        escalation: { category: string; severity: string; alertId: string; created: boolean; emailDelivered: boolean };
        reply: { body: string };
      };
    };

    expect(response.status).toBe(200);

    // 1. The alert row is written with the values /admin filters on.
    const escalate = calls.find((call) => call.fn === "ofoq_client_escalate");
    expect(escalate?.args).toMatchObject({
      p_conversation_id: "conv-1",
      p_category: "HUMAN_REQUEST",
      p_severity: "URGENT",
      p_title_ar: "عميل جديد يطلب تواصل",
      p_title_en: "New client requesting contact",
    });

    // 2. The owner is emailed before the client is told anything.
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledOnce();
    const email = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as { body: string }).body)) as {
      to: string[];
      subject: string;
      text: string;
    };
    expect(email.to).toContain(DEFAULT_OWNER_EMAIL);
    expect(email.subject).toContain("طلب التحدث مع فريق بشري");
    expect(email.text).toContain("أريد أتكلم مع بشري");

    // 3. The client sees the handoff — and only because it really happened.
    expect(payload.data.escalated).toBe(true);
    expect(payload.data.escalation).toMatchObject({
      category: "HUMAN_REQUEST",
      severity: "URGENT",
      alertId: "alert-1",
      created: true,
      emailDelivered: true,
    });
    expect(payload.data.reply.body).toContain("تم تحويل محادثتك إلى فريق أفق البشري");

    // 4. The confirmation is part of the message that is persisted.
    const saved = calls.find((call) => call.fn === "ofoq_client_chat_reply");
    expect(String(saved?.args.p_body)).toContain("تم تحويل محادثتك إلى فريق أفق البشري");
    // 5. The delivery outcome is written back to the notifications.
    expect(calls.some((call) => call.fn === "ofoq_escalation_email_result")).toBe(true);
  });

  it("does not claim a handoff when the alert could not be written", async () => {
    escalateResponse = { data: null, error: { code: "42501", message: "Conversation not found" } };

    const response = await POST(postRequest("أريد أتكلم مع بشري"));
    const payload = (await response.json()) as { data: { escalated: boolean; reply: { body: string } } };

    expect(payload.data.escalated).toBe(false);
    expect(payload.data.reply.body).not.toContain("تم تحويل محادثتك");
    expect(payload.data.reply.body).toContain("تعذّر تسجيل تنبيه التحويل");
    // No email goes out for an escalation that was never recorded.
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("logs who was refused when the alert could not be written — owner included", async () => {
    // An OWNER without a `customers` row was the silent failure this fix is
    // about: the assistant answered, the handoff did not. The log has to name
    // the account, its role and the missing client record.
    ownProfile = { id: "user-1", role: "OWNER", status: "ACTIVE" };
    escalateResponse = { data: null, error: { code: "42501", message: "Conversation not found" } };

    const written: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });

    try {
      const response = await POST(postRequest("أريد أتكلم مع بشري"));
      const payload = (await response.json()) as { data: { escalated: boolean; reply: { body: string } } };

      expect(payload.data.escalated).toBe(false);
      expect(payload.data.reply.body).toContain("تعذّر تسجيل تنبيه التحويل");

      const line = written.map((entry) => JSON.parse(entry) as Record<string, unknown>).find((entry) => entry.message === "[escalation] alert row was not written");
      expect(line).toBeTruthy();
      expect(line).toMatchObject({
        userId: "user-1",
        role: "OWNER",
        customerId: "customer-1",
        conversationId: "conv-1",
        category: "HUMAN_REQUEST",
        severity: "URGENT",
        code: "42501",
        error: "Conversation not found",
      });
      expect(String(line?.hint)).toContain("no customers row");
    } finally {
      stderr.mockRestore();
      ownProfile = { id: "user-1", role: "CLIENT", status: "ACTIVE" };
    }
  });

  it("escalates a NEW_LEAD once the need is understood, without a human request", async () => {
    const response = await POST(postRequest("الميزانية 500 دولار والتسليم خلال شهر"));
    const payload = (await response.json()) as { data: { escalated: boolean; escalation: { category: string } } };

    expect(payload.data.escalated).toBe(true);
    expect(payload.data.escalation.category).toBe("NEW_LEAD");
    expect(calls.find((call) => call.fn === "ofoq_client_escalate")?.args).toMatchObject({
      p_category: "NEW_LEAD",
      p_severity: "IMPORTANT",
    });
  });

  it("leaves an ordinary conversation alone", async () => {
    // No service and no scope yet: nothing to hand over.
    history = [{ role: "assistant", content: "أهلًا بك، كيف أساعدك؟" }];
    const response = await POST(postRequest("مرحبا"));
    const payload = (await response.json()) as { data: { escalated: boolean; escalation: unknown } };

    expect(payload.data.escalated).toBe(false);
    expect(payload.data.escalation).toBeNull();
    // Only the conversation RPCs run (plus AI usage logging): no alert, no email.
    expect(calls.map((call) => call.fn)).toContain("ofoq_client_chat_send");
    expect(calls.map((call) => call.fn)).toContain("ofoq_client_chat_reply");
    expect(calls.filter((call) => call.fn === "ofoq_client_escalate")).toHaveLength(0);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("GET /api/chat", () => {
  it("hands the registered client email to the guided service request", async () => {
    const response = await GET(new Request("http://localhost/api/chat"));
    const body = await response.json();

    expect(calls.map((call) => call.fn)).toContain("ofoq_client_chat_bootstrap");
    // The guided pricing message addresses the client by the registered address,
    // so the bootstrap payload must carry it (db/migrations/supabase/0001...).
    expect(body.data).toMatchObject({ conversationId: "conv-1", customerName: "نور", email: "client@example.test" });
    expect(body.data.messages).toHaveLength(1);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });

  it("still answers when the client has no registered email", async () => {
    bootstrapPayload = { ...bootstrapPayload, email: null };

    const body = await (await GET(new Request("http://localhost/api/chat"))).json();

    expect(body.data.email).toBeNull();
  });
});
