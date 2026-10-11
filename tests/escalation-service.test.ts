import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_OWNER_EMAIL,
  describeEscalationError,
  escalationRecipients,
  raiseClientEscalation,
  type EscalationRpcClient,
} from "../src/lib/services/escalation.service";
import { callBody, callHeaders, callUrl } from "./ai/completion-mock";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}

/** Records every RPC the service issues, like the Supabase client would. */
function fakeClient(options: {
  escalate?: Record<string, unknown>;
  error?: { code: string; message: string } | null;
  throws?: boolean;
} = {}): { client: EscalationRpcClient; calls: RpcCall[] } {
  const calls: RpcCall[] = [];
  const client: EscalationRpcClient = {
    rpc(fn, args) {
      calls.push({ fn, args: (args ?? {}) as Record<string, unknown> });
      if (options.throws) return Promise.reject(new Error("network down"));
      if (options.error) return Promise.resolve({ data: null, error: options.error });
      if (fn === "ofoq_client_escalate") {
        return Promise.resolve({
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
            ...options.escalate,
          },
          error: null,
        });
      }
      return Promise.resolve({ data: { updated: 1 }, error: null });
    },
  };
  return { client, calls };
}

const resendOk = () =>
  new Response(JSON.stringify({ id: "email-id-1" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

describe("escalation service", () => {
  it("writes the alert through the RPC with the required column values", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(resendOk()));
    const { client, calls } = fakeClient();

    const outcome = await raiseClientEscalation({
      client,
      conversationId: "conv-1",
      latestMessage: "أريد أتكلم مع بشري",
      history: [{ role: "user", content: "أحتاج حملة إعلانية لمتجري" }],
      locale: "ar",
    });

    expect(outcome.escalated).toBe(true);
    expect(outcome.created).toBe(true);
    expect(outcome.alertId).toBe("alert-1");
    expect(outcome.conversationStatus).toBe("PENDING");

    const escalate = calls.find((call) => call.fn === "ofoq_client_escalate");
    expect(escalate?.args).toMatchObject({
      p_conversation_id: "conv-1",
      p_category: "HUMAN_REQUEST",
      p_severity: "URGENT",
      p_title_ar: "عميل جديد يطلب تواصل",
      p_title_en: "New client requesting contact",
    });
    expect(String(escalate?.args.p_body_ar)).toContain("أريد أتكلم مع بشري");
    expect(String(escalate?.args.p_body_en)).toContain("Human handoff");
  });

  it("emails the owner and records the delivery on the notification rows", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    const fetchMock = vi.fn().mockResolvedValue(resendOk());
    vi.stubGlobal("fetch", fetchMock);
    const { client, calls } = fakeClient();

    const outcome = await raiseClientEscalation({
      client,
      conversationId: "conv-1",
      latestMessage: "أريد أتكلم مع بشري",
      locale: "ar",
    });

    // The configured owner plus the staff row returned by the RPC, de-duplicated.
    expect(outcome.email.delivered).toBe(true);
    expect(outcome.email.provider).toBe("resend");
    expect(outcome.email.recipients).toContain(DEFAULT_OWNER_EMAIL);
    expect(outcome.email.recipients).toContain("owner@example.test");

    const body = callBody(fetchMock, 0);
    expect(callUrl(fetchMock, 0)).toContain("https://api.resend.com/emails");
    expect((body.to as string[]).join(",")).toContain(DEFAULT_OWNER_EMAIL);
    expect(String(body.subject)).toContain("طلب التحدث مع فريق بشري");
    expect(String(body.text)).toContain("conv-1");
    // The API key travels in a header, never in the URL.
    expect(callHeaders(fetchMock, 0).authorization).toContain("re_test_key");
    expect(callUrl(fetchMock, 0)).not.toContain("re_test_key");

    const result = calls.find((call) => call.fn === "ofoq_escalation_email_result");
    expect(result?.args).toMatchObject({ p_alert_id: "alert-1", p_delivered: true, p_provider: "resend" });
  });

  it("still counts as escalated when Resend is not configured, and says so", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { client, calls } = fakeClient();

    const outcome = await raiseClientEscalation({
      client,
      conversationId: "conv-1",
      latestMessage: "I want to speak with a human",
      locale: "en",
    });

    expect(outcome.escalated).toBe(true);
    expect(outcome.email.attempted).toBe(true);
    expect(outcome.email.delivered).toBe(false);
    expect(outcome.email.provider).toBe("console");
    expect(fetchMock).not.toHaveBeenCalled();
    // The failure is written back so /admin can show it.
    expect(
      calls.find((call) => call.fn === "ofoq_escalation_email_result")?.args,
    ).toMatchObject({ p_delivered: false, p_provider: "console" });
    expect(outcome.notice).toContain("handed over");
  });

  it("never tells the client it was escalated when the alert write failed", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    const fetchMock = vi.fn().mockResolvedValue(resendOk());
    vi.stubGlobal("fetch", fetchMock);
    const { client, calls } = fakeClient({ error: { code: "42501", message: "Conversation not found" } });

    const outcome = await raiseClientEscalation({
      client,
      conversationId: "conv-1",
      latestMessage: "أريد أتكلم مع بشري",
      locale: "ar",
    });

    expect(outcome.escalated).toBe(false);
    expect(outcome.alertId).toBeNull();
    expect(outcome.email.attempted).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(outcome.notice).toContain("تعذّر");
    expect(calls.map((call) => call.fn)).toEqual(["ofoq_client_escalate"]);
  });

  it("does not throw when the RPC call itself blows up", async () => {
    const { client } = fakeClient({ throws: true });

    const outcome = await raiseClientEscalation({
      client,
      conversationId: "conv-1",
      latestMessage: "أريد أتكلم مع بشري",
      locale: "ar",
    });

    expect(outcome.escalated).toBe(false);
    expect(outcome.error).toBe("network down");
    expect(outcome.notice).toContain("تعذّر");
  });

  it("logs who was refused, with a hint, when the alert write is denied", async () => {
    // The failure this whole fix is about: an OWNER with no `customers` row
    // gets 42501 from the SQL. Without the caller context in the log it is
    // impossible to tell that apart from a wrong conversation id.
    const { client } = fakeClient({ error: { code: "42501", message: "Conversation not found" } });
    const written: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });

    try {
      const outcome = await raiseClientEscalation({
        client,
        conversationId: "conv-owner-1",
        latestMessage: "أريد أتكلم مع بشري",
        locale: "ar",
        context: { userId: "owner-1", role: "OWNER", customerId: null },
      });

      expect(outcome.escalated).toBe(false);

      const line = written
        .map((entry) => JSON.parse(entry) as Record<string, unknown>)
        .find((entry) => entry.message === "[escalation] alert row was not written");
      expect(line).toMatchObject({
        userId: "owner-1",
        role: "OWNER",
        customerId: null,
        conversationId: "conv-owner-1",
        code: "42501",
        error: "Conversation not found",
      });
      expect(String(line?.hint)).toContain("no customers row");
    } finally {
      stderr.mockRestore();
    }
  });

  it("logs the identity the database saw when the alert is written", async () => {
    const { client } = fakeClient({
      escalate: { identity: { userId: "owner-1", role: "OWNER", isStaff: true, customerId: null } },
    });
    const written: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });

    try {
      const outcome = await raiseClientEscalation({
        client,
        conversationId: "conv-owner-1",
        latestMessage: "أريد أتكلم مع بشري",
        locale: "ar",
        sendOwnerEmail: false,
        context: { userId: "owner-1", role: "OWNER", customerId: null },
      });

      expect(outcome.escalated).toBe(true);
      const line = written
        .map((entry) => JSON.parse(entry) as Record<string, unknown>)
        .find((entry) => entry.message === "Client conversation escalated to the human team");
      expect(line).toMatchObject({
        userId: "owner-1",
        role: "OWNER",
        identity: { role: "OWNER", isStaff: true, customerId: null },
      });
    } finally {
      stdout.mockRestore();
    }
  });

  it("does not email the owner twice for the same open alert", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    const fetchMock = vi.fn().mockResolvedValue(resendOk());
    vi.stubGlobal("fetch", fetchMock);
    // The RPC deduplicates per conversation + category + day.
    const { client, calls } = fakeClient({ escalate: { created: false } });

    const outcome = await raiseClientEscalation({
      client,
      conversationId: "conv-1",
      latestMessage: "أريد أتكلم مع بشري",
      locale: "ar",
    });

    expect(outcome.escalated).toBe(true);
    expect(outcome.created).toBe(false);
    expect(outcome.email.attempted).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(calls.map((call) => call.fn)).toEqual(["ofoq_client_escalate"]);
    // The client is still told the truth: an alert for the team is open.
    expect(outcome.notice).toContain("تم تحويل محادثتك");
  });

  it("is a no-op when nothing needs a human", async () => {
    const { client, calls } = fakeClient();

    const outcome = await raiseClientEscalation({
      client,
      conversationId: "conv-1",
      latestMessage: "مرحبا",
      locale: "ar",
    });

    expect(outcome.escalated).toBe(false);
    expect(outcome.notice).toBe("");
    expect(calls).toHaveLength(0);
  });

  it("turns a raw Postgres error into the next thing to look at", () => {
    expect(describeEscalationError("PGRST202", "Could not find the function public.ofoq_client_escalate")).toContain(
      "ofoq_client_escalate",
    );
    expect(describeEscalationError("42501", "Not allowed to escalate this conversation")).toContain(
      "no customers row",
    );
    expect(describeEscalationError("42703", "column alerts.dedupe_key does not exist")).toContain("dedupe_key");
    expect(describeEscalationError("23502", "null value in column customer_id")).toContain("nullable");
    expect(describeEscalationError("42P01", "relation public.alerts does not exist")).toContain("alerts");
    // Unknown failures still point at the diagnostics endpoint.
    expect(describeEscalationError("XX000", "something else")).toContain("/api/debug/escalation");
  });

  it("collects recipients from OWNER_EMAIL, staff rows and the documented fallback", () => {
    vi.stubEnv("OWNER_EMAIL", " Boss@Example.test , ");
    expect(escalationRecipients(["owner@example.test", null, "not-an-email"])).toEqual([
      "boss@example.test",
      "owner@example.test",
    ]);

    vi.stubEnv("OWNER_EMAIL", "");
    expect(escalationRecipients([])).toEqual([DEFAULT_OWNER_EMAIL]);
  });
});
