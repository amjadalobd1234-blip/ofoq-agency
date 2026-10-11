import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchEscalationDiagnostics } from "../src/lib/services/escalation.service";

/**
 * GET /api/debug/escalation — the endpoint an owner opens in the browser when a
 * handoff is not recorded. It must stay useful on a broken project: a missing
 * migration has to come back as a readable report, never as a 500 or a throw.
 */
interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}

const rpcCalls: RpcCall[] = [];
let rpcResult: { data: unknown; error: { code?: string; message?: string } | null } = {
  data: { caller: { role: "OWNER" } },
  error: null,
};

vi.mock("@/lib/supabase/route-auth", () => ({
  requireSupabaseUser: () =>
    Promise.resolve({
      client: {
        rpc(fn: string, args?: Record<string, unknown>) {
          rpcCalls.push({ fn, args: (args ?? {}) as Record<string, unknown> });
          return Promise.resolve(rpcResult);
        },
      },
      user: { id: "user-1", email: "owner@example.test" },
    }),
  rpcFailureResponse: (error: { message?: string }) =>
    Response.json({ error: error?.message ?? "rpc failed" }, { status: 502 }),
}));

const { GET } = await import("../src/app/api/debug/escalation/route");

beforeEach(() => {
  rpcCalls.length = 0;
  rpcResult = { data: { caller: { role: "OWNER" } }, error: null };
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("GET /api/debug/escalation", () => {
  it("returns the database report for the signed-in account", async () => {
    rpcResult = {
      data: {
        caller: { userId: "user-1", role: "OWNER", hasCustomerRecord: true, customerId: "user-1" },
        conversation: { id: "conv-1", ownedByCaller: true },
        alerts: { tableExists: true, customerIdNullable: true },
        escalateFunctionExists: true,
      },
      error: null,
    };

    const response = await GET(new Request("http://localhost/api/debug/escalation"));
    const payload = (await response.json()) as { ok: boolean; data: { caller: { role: string } } };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.data.caller.role).toBe("OWNER");
    // No conversation id in the query → the SQL picks the caller's own one.
    expect(rpcCalls).toEqual([{ fn: "ofoq_escalation_diagnostics", args: {} }]);
  });

  it("forwards the conversation id when one is given", async () => {
    const response = await GET(
      new Request("http://localhost/api/debug/escalation?conversationId=conv-9"),
    );
    await response.json();

    expect(rpcCalls).toEqual([
      { fn: "ofoq_escalation_diagnostics", args: { p_conversation_id: "conv-9" } },
    ]);
  });

  it("reports a missing migration instead of failing silently", async () => {
    rpcResult = {
      data: null,
      error: { code: "PGRST202", message: "Could not find the function public.ofoq_escalation_diagnostics" },
    };

    const response = await GET(new Request("http://localhost/api/debug/escalation"));
    const payload = (await response.json()) as { ok: boolean; error: string; hint: string };

    expect(response.status).toBe(502);
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain("ofoq_escalation_diagnostics");
    // The next action the owner has to take, in one line.
    expect(payload.hint).toContain("docs/setup/supabase-setup.sql");
  });
});

describe("fetchEscalationDiagnostics", () => {
  it("never throws, even when the transport itself fails", async () => {
    const report = await fetchEscalationDiagnostics({
      rpc: () => Promise.reject(new Error("network down")),
    });

    expect(report.ok).toBe(false);
    expect(report.error).toBe("network down");
    expect(report.hint).toBeTruthy();
  });

  it("passes no arguments when there is no conversation id", async () => {
    const calls: RpcCall[] = [];
    const report = await fetchEscalationDiagnostics(
      {
        rpc(fn, args) {
          calls.push({ fn, args: (args ?? {}) as Record<string, unknown> });
          return Promise.resolve({ data: { caller: {} }, error: null });
        },
      },
      null,
    );

    expect(report.ok).toBe(true);
    expect(calls).toEqual([{ fn: "ofoq_escalation_diagnostics", args: {} }]);
  });
});
