import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  describeAlertInsertError,
  fetchEscalationDiagnostics,
  probeAlertInsert,
} from "../src/lib/services/escalation.service";

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
/** Direct table writes made through `client.from(...)`, in order. */
const tableCalls: Array<{ op: "insert" | "delete"; table: string; values?: Record<string, unknown>; id?: string }> = [];
let insertResult: { error: { code?: string; message?: string; details?: string | null; hint?: string | null } | null } = {
  error: null,
};
let deleteResult: { error: { code?: string; message?: string } | null } = { error: null };

vi.mock("@/lib/supabase/route-auth", () => ({
  requireSupabaseUser: () =>
    Promise.resolve({
      client: {
        rpc(fn: string, args?: Record<string, unknown>) {
          rpcCalls.push({ fn, args: (args ?? {}) as Record<string, unknown> });
          return Promise.resolve(rpcResult);
        },
        from(table: string) {
          return {
            insert(values: Record<string, unknown>) {
              tableCalls.push({ op: "insert", table, values });
              return Promise.resolve(insertResult);
            },
            delete() {
              return {
                eq(_column: string, id: string) {
                  tableCalls.push({ op: "delete", table, id });
                  return Promise.resolve(deleteResult);
                },
              };
            },
          };
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
  tableCalls.length = 0;
  rpcResult = { data: { caller: { role: "OWNER" } }, error: null };
  insertResult = { error: null };
  deleteResult = { error: null };
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

describe("GET /api/debug/escalation?insertTest=1", () => {
  it("writes nothing unless the insert test is requested", async () => {
    const response = await GET(new Request("http://localhost/api/debug/escalation"));
    const payload = (await response.json()) as { insertTest: unknown };

    expect(tableCalls).toEqual([]);
    expect(payload.insertTest).toBeNull();
  });

  it("inserts a labelled probe row and deletes it when the INSERT succeeds", async () => {
    const response = await GET(new Request("http://localhost/api/debug/escalation?insertTest=1&conversationId=conv-7"));
    const payload = (await response.json()) as {
      insertTest: { probeId: string; insert: { ok: boolean }; cleanup: { attempted: boolean; ok: boolean }; hint: string | null };
    };

    expect(response.status).toBe(200);
    expect(tableCalls).toHaveLength(2);
    const [insert, remove] = tableCalls;
    expect(insert.op).toBe("insert");
    expect(insert.table).toBe("alerts");
    expect(insert.values).toMatchObject({
      severity: "IMPORTANT",
      category: "DEBUG_PROBE",
      entity_type: "conversation",
      entity_id: "conv-7",
      target_role: "ANY_STAFF",
      status: "NEW",
      dedupe_key: null,
    });
    expect(String(insert.values?.id)).toMatch(/^debug-probe-/);
    expect(remove).toEqual({ op: "delete", table: "alerts", id: insert.values?.id });

    expect(payload.insertTest.insert.ok).toBe(true);
    expect(payload.insertTest.cleanup).toMatchObject({ attempted: true, ok: true });
    expect(payload.insertTest.hint).toBeNull();
  });

  it("returns the full database error when the INSERT is refused, and does not try to delete", async () => {
    insertResult = {
      error: {
        code: "42501",
        message: "permission denied for table alerts",
        details: "grant missing",
        hint: null,
      },
    };

    const response = await GET(new Request("http://localhost/api/debug/escalation?insertTest=1"));
    const payload = (await response.json()) as {
      ok: boolean;
      insertTest: {
        insert: { ok: boolean; error: { code: string; message: string; details: string } };
        cleanup: { attempted: boolean };
        hint: string;
      };
    };

    // The diagnostics report is still returned alongside the probe result.
    expect(payload.ok).toBe(true);
    expect(payload.insertTest.insert.ok).toBe(false);
    expect(payload.insertTest.insert.error).toEqual({
      code: "42501",
      message: "permission denied for table alerts",
      details: "grant missing",
      hint: null,
    });
    expect(payload.insertTest.cleanup.attempted).toBe(false);
    expect(payload.insertTest.hint).toContain("INSERT grant");
    expect(tableCalls.map((call) => call.op)).toEqual(["insert"]);
  });

  it("reports a probe row that could not be deleted, with its id", async () => {
    deleteResult = { error: { code: "42501", message: "permission denied for table alerts" } };

    const response = await GET(new Request("http://localhost/api/debug/escalation?insertTest=1"));
    const payload = (await response.json()) as {
      insertTest: { probeId: string; insert: { ok: boolean }; cleanup: { ok: boolean }; hint: string };
    };

    expect(payload.insertTest.insert.ok).toBe(true);
    expect(payload.insertTest.cleanup.ok).toBe(false);
    expect(payload.insertTest.hint).toContain(payload.insertTest.probeId);
  });
});

describe("probeAlertInsert", () => {
  it("never throws when the transport itself fails", async () => {
    const probe = await probeAlertInsert({
      from: () => ({
        insert: () => Promise.reject(new Error("socket hang up")),
        delete: () => ({ eq: () => Promise.resolve({ error: null }) }),
      }),
    });

    expect(probe.insert.ok).toBe(false);
    expect(probe.insert.error?.message).toBe("socket hang up");
    expect(probe.cleanup.attempted).toBe(false);
  });
});

describe("describeAlertInsertError", () => {
  it("names the grant when the direct INSERT is refused", () => {
    expect(describeAlertInsertError({ code: "42501", message: "permission denied for table alerts" })).toContain("INSERT grant");
  });

  it("names the RLS policy when the row itself is rejected", () => {
    expect(
      describeAlertInsertError({ code: "42501", message: 'new row violates row-level security policy for table "alerts"' }),
    ).toContain("alerts_insert_authenticated");
  });

  it("explains a missing table and a CHECK violation", () => {
    expect(describeAlertInsertError({ code: "42P01", message: 'relation "public.alerts" does not exist' })).toContain("does not exist");
    expect(describeAlertInsertError({ code: "23514", message: "violates check constraint" })).toContain("CHECK");
  });

  it("returns null when nothing failed", () => {
    expect(describeAlertInsertError(null)).toBeNull();
  });
});
