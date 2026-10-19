import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Offers API wiring: UI → routes → services → permissions.
 * Supabase session resolution is mocked (same pattern as the other route
 * tests); the service layer and the database are real.
 */
const profiles = vi.hoisted(() => ({ byId: new Map<string, { id: string; role: string; status: string }>() }));

vi.mock("@/lib/supabase/config", () => ({
  getSupabaseConfig: () => ({ url: "https://test.supabase.co", anonKey: "test" }),
}));

vi.mock("@/lib/supabase/route-auth", () => ({
  requireSupabaseUser: (request: Request) => {
    const id = request.headers.get("x-test-user");
    if (!id) return Promise.resolve({ response: Response.json({ error: "auth" }, { status: 401 }) });
    return Promise.resolve({
      client: {}, user: { id }, requestId: "test",
      finalize: (response: Response) => response,
    });
  },
  fetchOwnProfile: (_client: unknown, id: string) => {
    const profile = profiles.byId.get(id);
    return Promise.resolve(profile ? { profile } : { error: { code: "NO_PROFILE", message: "none" } });
  },
}));

const { POST: createOffer } = await import("../src/app/api/offers/route");
const { PATCH: patchOffer } = await import("../src/app/api/offers/[id]/route");
const { POST: sendOfferRoute } = await import("../src/app/api/offers/[id]/send/route");
const { POST: decideRoute } = await import("../src/app/api/offers/[id]/decision/route");
const { POST: invoiceRoute } = await import("../src/app/api/offers/[id]/invoice/route");
const { createCustomer } = await import("../src/lib/repositories/customers.repo");
const { createUser } = await import("../src/lib/repositories/identity.repo");

function req(userId: string | null, body?: unknown, method = "POST"): Request {
  return new Request("http://localhost/api/offers", {
    method,
    headers: { "Content-Type": "application/json", ...(userId ? { "x-test-user": userId } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe("offers API routes", () => {
  let ownerId = "";
  let clientId = "";
  let otherId = "";

  beforeAll(async () => {
    const owner = await createUser({ email: "api-owner@example.test", name: "Owner", role: "OWNER" });
    const clientUser = await createUser({ email: "api-client@example.test", name: "Client", role: "CLIENT" });
    const otherUser = await createUser({ email: "api-other@example.test", name: "Other", role: "CLIENT" });
    ownerId = owner.id; clientId = clientUser.id; otherId = otherUser.id;
    const customer = await createCustomer({ user_id: clientUser.id, contact_name: "Client", email: clientUser.email, locale: "ar", currency: "USD", country: "IQ", status: "ACTIVE" });
    const otherCustomer = await createCustomer({ user_id: otherUser.id, contact_name: "Other", email: otherUser.email, locale: "ar", currency: "USD", country: "IQ", status: "ACTIVE" });
    void otherCustomer; void customer;
    profiles.byId.set(ownerId, { id: ownerId, role: "OWNER", status: "ACTIVE" });
    profiles.byId.set(clientId, { id: clientId, role: "CLIENT", status: "ACTIVE" });
    profiles.byId.set(otherId, { id: otherId, role: "CLIENT", status: "ACTIVE" });
  });

  it("runs the full wired flow with separated owner approval and client decision", async () => {
    // 1) Client requests a formal offer → DRAFT only, safe view (no internals).
    const created = await createOffer(req(clientId, { services: ["consulting"] }));
    expect(created.status).toBe(201);
    const createdBody = await created.json() as { data: { id: string; code: string; status: string } };
    expect(createdBody.data.code).toMatch(/^OFOQ-\d{4}-\d{3,}$/);
    expect(createdBody.data.status).toBe("DRAFT");
    expect(JSON.stringify(createdBody)).not.toContain("internal");
    const offerId = createdBody.data.id;

    // Unauthenticated callers are refused.
    expect((await createOffer(req(null, { services: ["consulting"] }))).status).toBe(401);

    // 2) The client cannot bypass owner approval, and cannot decide on a draft.
    expect((await sendOfferRoute(req(clientId), ctx(offerId))).status).toBe(403);
    expect((await decideRoute(req(clientId, { decision: "accept" }), ctx(offerId))).status).toBe(412);

    // 3) Owner edits the draft, then approves+sends it.
    const patched = await patchOffer(req(ownerId, { validForDays: 10 }, "PATCH"), ctx(offerId));
    expect(patched.status).toBe(200);
    expect((await patchOffer(req(clientId, { validForDays: 5 }, "PATCH"), ctx(offerId))).status).toBe(403);
    const sent = await sendOfferRoute(req(ownerId), ctx(offerId));
    expect(sent.status).toBe(200);
    expect(((await sent.json()) as { data: { status: string } }).data.status).toBe("SENT");
    // No re-send, no editing after send.
    expect((await sendOfferRoute(req(ownerId), ctx(offerId))).status).toBe(412);
    expect((await patchOffer(req(ownerId, { validForDays: 5 }, "PATCH"), ctx(offerId))).status).toBe(412);

    // 4) Only the owning client decides; acceptance issues NO invoice/email.
    expect((await decideRoute(req(otherId, { decision: "accept" }), ctx(offerId))).status).toBe(403);
    expect((await decideRoute(req(ownerId, { decision: "accept" }), ctx(offerId))).status).toBe(412);
    // Owner invoicing is impossible before acceptance.
    expect((await invoiceRoute(req(ownerId), ctx(offerId))).status).toBe(412);
    const accepted = await decideRoute(req(clientId, { decision: "accept" }), ctx(offerId));
    expect(accepted.status).toBe(200);
    const acceptedBody = await accepted.json() as { data: { status: string; invoiceId: string | null; alertId: string | null } };
    expect(acceptedBody.data.status).toBe("APPROVED");
    expect(acceptedBody.data.invoiceId).toBeNull();
    expect(acceptedBody.data.alertId).toBeTruthy();

    // 5) Invoicing is the owner's separate explicit action (idempotent).
    expect((await invoiceRoute(req(clientId), ctx(offerId))).status).toBe(403);
    const issued = await invoiceRoute(req(ownerId), ctx(offerId));
    expect(issued.status).toBe(201);
    const issuedBody = await issued.json() as { data: { invoiceId: string; created: boolean } };
    expect(issuedBody.data.created).toBe(true);
    const reissued = await invoiceRoute(req(ownerId), ctx(offerId));
    expect(reissued.status).toBe(200);
    expect(((await reissued.json()) as { data: { invoiceId: string; created: boolean } }).data)
      .toMatchObject({ invoiceId: issuedBody.data.invoiceId, created: false });
  });
});
