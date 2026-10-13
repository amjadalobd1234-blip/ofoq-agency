import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { plainText } from "./helpers/bidi";

/**
 * End-to-end wiring of POST /api/chat/service-request — the route the chat calls
 * when the guided request is complete.
 *
 * Only the Supabase transport is replaced (a fake RPC client that records what
 * it is asked) and the network (Resend). Everything in between — validation,
 * the pricing, the alert text, the RPC arguments, the error surfacing — is the
 * real code path. The request must reach `ofoq_client_service_request` with an
 * IMPORTANT / NEW_REQUEST alert and a DRAFT offer, and never the human-handoff
 * RPC `ofoq_client_escalate`.
 */

interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}

const calls: RpcCall[] = [];
let rpcResponse: { data: unknown; error: { code: string; message: string; details?: string | null } | null } | Error;
let finalized = 0;

function fakeSupabaseClient() {
  return {
    rpc(fn: string, args?: Record<string, unknown>) {
      calls.push({ fn, args: (args ?? {}) as Record<string, unknown> });
      if (rpcResponse instanceof Error) return Promise.reject(rpcResponse);
      return Promise.resolve(rpcResponse);
    },
    from(table: string) {
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: () =>
          Promise.resolve(
            table === "customers"
              ? { data: { id: "customer-1", email: "client@example.test", contact_name: "نور" }, error: null }
              : { data: null, error: null },
          ),
      };
      return builder;
    },
  };
}

vi.mock("@/lib/supabase/route-auth", () => ({
  requireSupabaseUser: () =>
    Promise.resolve({
      client: fakeSupabaseClient(),
      user: { id: "user-1", email: "client@example.test" },
      requestId: "corr-1",
      finalize: (response: Response) => {
        finalized += 1;
        return response;
      },
    }),
  rpcFailureResponse: (error: { message?: string }) => Response.json({ error: error?.message ?? "rpc failed" }, { status: 502 }),
  fetchOwnProfile: () => Promise.resolve({ profile: { id: "user-1", role: "CLIENT", status: "ACTIVE" } }),
}));

const { POST } = await import("../src/app/api/chat/service-request/route");

const TYPED_NUMBER = "07707048629";

function savedRpc(orderCode = "OFOQ-2026-004", created = true) {
  return {
    data: {
      requestId: "req-1",
      orderCode,
      offerId: "offer-1",
      offerStatus: "DRAFT",
      alertId: "alert-1",
      created,
      category: "NEW_REQUEST",
      severity: "IMPORTANT",
      conversationId: "conv-1",
      customerId: "customer-1",
      staff: 2,
    },
    error: null,
  };
}

function post(body: unknown): Request {
  return new Request("http://localhost/api/chat/service-request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const whatsappBody = {
  requestId: "11111111-2222-4333-8444-555555555555",
  answers: {
    type: "ads",
    size: "medium",
    budget: "200_500",
    budgetRange: "200-500",
    budgetAmount: "500",
    targeting: "iraq_all",
    contact: "whatsapp",
    phone: TYPED_NUMBER,
  },
  locale: "ar",
  conversationId: "conv-1",
};

beforeEach(() => {
  calls.length = 0;
  finalized = 0;
  rpcResponse = savedRpc();
  vi.stubEnv("RESEND_API_KEY", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("POST /api/chat/service-request", () => {
  it("saves through ofoq_client_service_request with the NEW_REQUEST / IMPORTANT alert and a DRAFT offer", async () => {
    const response = await POST(post(whatsappBody));
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { data: Record<string, any> };

    expect(payload.data).toMatchObject({
      requestId: whatsappBody.requestId,
      orderCode: "OFOQ-2026-004",
      offerStatus: "DRAFT",
      offer: { status: "DRAFT", code: "OFOQ-2026-004" },
      alertId: "alert-1",
      alert: { category: "NEW_REQUEST", severity: "IMPORTANT" },
      created: true,
      budget: { range: "200-500", amount: 500, band: "200_500", source: "typed" },
      contact: { channel: "whatsapp", value: TYPED_NUMBER, whatsappNumber: "9647707048629", whatsappLink: "https://wa.me/9647707048629" },
    });
    expect(payload.data.email).toMatchObject({ delivered: false });
    expect(finalized).toBe(1);

    // The one RPC is the service-request one — never the human handoff.
    expect(calls.map((call) => call.fn)).toEqual(["ofoq_client_service_request"]);
    const args = calls[0]!.args;
    expect(args.p_request_id).toBe(whatsappBody.requestId);
    expect(args.p_title_ar).toBe("طلب خدمة جديد");
    expect(args.p_title_en).toBe("New service request");
    expect(args.p_conversation_id).toBe("conv-1");
    expect(args.p_locale).toBe("ar");
    expect(args.p_offer).toMatchObject({ status: "DRAFT", currency: "USD", pricing_reason: "service_request:ads:200_500:iraq_all" });
    expect((args.p_offer as Record<string, any>).pricing_breakdown).toMatchObject({ budgetRange: "200-500", budgetAmount: 500, status: "DRAFT" });
    expect(args.p_contact).toEqual({ channel: "whatsapp", value: TYPED_NUMBER, whatsappNumber: "9647707048629", whatsappLink: "https://wa.me/9647707048629" });
    const body = String(args.p_body_ar);
    expect(body).toContain("قناة التواصل: واتساب");
    expect(body).toContain(`رقم العميل: ${TYPED_NUMBER}`);
    expect(body).toContain("رابط واتساب: https://wa.me/9647707048629");
    expect(plainText(body)).toContain("الميزانية: 200-500$");
    expect(body).not.toContain("500 من 200");
    const meta = args.p_meta as Record<string, any>;
    expect(meta).toMatchObject({ source: "guided_service_request", offerStatus: "DRAFT", conversationId: "conv-1" });
    expect(meta.whatsapp).toEqual({ channel: "واتساب", number: TYPED_NUMBER, international: "9647707048629", link: "https://wa.me/9647707048629" });
    expect(meta.budget).toMatchObject({ range: "200-500", amount: 500 });
    // Nothing in the alert is the human-handoff shape.
    expect(JSON.stringify(args)).not.toContain("HUMAN_REQUEST");
    expect(JSON.stringify(args)).not.toContain("URGENT");
  });

  it("reports a retried request as already saved with the same order", async () => {
    rpcResponse = savedRpc("OFOQ-2026-004", false);
    const response = await POST(post(whatsappBody));
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { data: Record<string, any> };
    expect(payload.data).toMatchObject({ orderCode: "OFOQ-2026-004", created: false });
    expect(payload.data.email).toMatchObject({ delivered: false, provider: "skipped" });
  });

  it("drops a typed budget that contradicts its band and prices the band", async () => {
    const response = await POST(post({ ...whatsappBody, answers: { ...whatsappBody.answers, budget: "under_200", budgetRange: "200-500", budgetAmount: "500" } }));
    const payload = (await response.json()) as { data: Record<string, any> };
    expect(payload.data.budget).toMatchObject({ band: "under_200", range: "<200", amount: 200, source: "option" });
    expect((calls[0]!.args.p_offer as Record<string, any>).pricing_reason).toBe("service_request:ads:under_200:iraq_all");
  });

  it("answers a clear 502 with a hint when the RPC is not installed — never a silent success", async () => {
    rpcResponse = { data: null, error: { code: "PGRST202", message: "Could not find the function public.ofoq_client_service_request(...) in the schema cache" } };
    const response = await POST(post(whatsappBody));
    expect(response.status).toBe(502);
    const payload = (await response.json()) as Record<string, unknown>;
    expect(payload).toMatchObject({ code: "SERVICE_REQUEST_RPC_NOT_INSTALLED", requestId: whatsappBody.requestId, correlationId: "corr-1" });
    expect(String(payload.error)).toContain("not installed");
    expect(String(payload.hint)).toContain("0008_service_requests.sql");
  });

  it("surfaces a schema rejection (REQUESTED is not an allowed status yet) as an error", async () => {
    rpcResponse = { data: null, error: { code: "23514", message: 'new row for relation "offers" violates check constraint "offers_status_check"', details: null } };
    const response = await POST(post(whatsappBody));
    expect(response.status).toBe(502);
    const payload = (await response.json()) as Record<string, unknown>;
    expect(payload.code).toBe("SERVICE_REQUEST_SAVE_FAILED");
    expect(String(payload.hint)).toContain("offers.status CHECK");
    expect(String(payload.hint)).toContain("0009_offers_requested_status");
  });

  it("surfaces an unreachable database", async () => {
    rpcResponse = new Error("fetch failed");
    const response = await POST(post(whatsappBody));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: "SERVICE_REQUEST_RPC_UNREACHABLE" });
  });

  it("rejects an invalid WhatsApp number, an unknown channel and bad JSON before touching the database", async () => {
    expect((await POST(post({ ...whatsappBody, answers: { ...whatsappBody.answers, phone: "12345" } }))).status).toBe(400);
    expect((await POST(post({ ...whatsappBody, answers: { ...whatsappBody.answers, contact: "pigeon" } }))).status).toBe(400);
    expect((await POST(post("{nope"))).status).toBe(400);
    expect((await POST(post({ ...whatsappBody, requestId: "x" }))).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("saves an email request with the registered address and no WhatsApp block", async () => {
    const response = await POST(post({ ...whatsappBody, requestId: undefined, answers: { type: "design", size: "small", budget: "under_200", targeting: "baghdad", contact: "email" } }));
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { data: Record<string, any> };
    expect(payload.data.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(payload.data.contact).toEqual({ channel: "email", value: "client@example.test" });
    const args = calls[0]!.args;
    expect(args.p_contact).toEqual({ channel: "email", value: "client@example.test", whatsappNumber: null, whatsappLink: null });
    expect((args.p_meta as Record<string, unknown>).whatsapp).toBeNull();
    expect(String(args.p_body_ar)).toContain("قناة التواصل: البريد الإلكتروني — client@example.test");
  });
});
