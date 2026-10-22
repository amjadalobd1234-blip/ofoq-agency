import { beforeAll, describe, expect, it, vi } from "vitest";

const profiles = vi.hoisted(() => ({ byId: new Map<string, { id: string; role: string; status: string }>() }));

vi.mock("@/lib/supabase/config", () => ({
  getSupabaseConfig: () => ({ url: "https://test.supabase.co", anonKey: "test" }),
}));

vi.mock("@/lib/supabase/route-auth", () => ({
  requireSupabaseUser: (request: Request) => {
    const id = request.headers.get("x-test-user");
    if (!id) return Promise.resolve({ response: Response.json({ error: "auth" }, { status: 401 }) });
    return Promise.resolve({
      client: {},
      user: { id },
      requestId: "test",
      finalize: (response: Response) => response,
    });
  },
  fetchOwnProfile: (_client: unknown, id: string) => {
    const profile = profiles.byId.get(id);
    return Promise.resolve(profile ? { profile } : { error: { code: "NO_PROFILE", message: "none" } });
  },
}));

const { GET: listAds, POST: createAds } = await import("../src/app/api/ads/route");
const { GET: getAds, PATCH: patchAds } = await import("../src/app/api/ads/[id]/route");
const { POST: submitAds } = await import("../src/app/api/ads/[id]/submit/route");
const { POST: approveAds } = await import("../src/app/api/ads/[id]/approve/route");
const { POST: recordResults } = await import("../src/app/api/ads/[id]/results/route");
const { POST: analyzeAds } = await import("../src/app/api/ads/[id]/analyze/route");
const { POST: launchAds } = await import("../src/app/api/ads/[id]/launch/route");

const { createCustomer } = await import("../src/lib/repositories/customers.repo");
const { createUser } = await import("../src/lib/repositories/identity.repo");

function req(userId: string | null, body?: unknown, method = "GET", path = "/api/ads"): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(userId ? { "x-test-user": userId } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

let ownerId = "";
let partnerId = "";
let clientId = "";
let otherClientId = "";
let customerId = "";

beforeAll(async () => {
  const owner = await createUser({ email: "ads-api-owner@example.test", name: "Owner", role: "OWNER" });
  const partner = await createUser({ email: "ads-api-partner@example.test", name: "Partner", role: "PARTNER" });
  const client = await createUser({ email: "ads-api-client@example.test", name: "Client", role: "CLIENT" });
  const other = await createUser({ email: "ads-api-other@example.test", name: "Other", role: "CLIENT" });
  ownerId = owner.id;
  partnerId = partner.id;
  clientId = client.id;
  otherClientId = other.id;

  const customer = await createCustomer({
    user_id: client.id,
    contact_name: "Client",
    email: client.email,
    locale: "ar",
    currency: "USD",
    country: "IQ",
    status: "ACTIVE",
  });
  await createCustomer({
    user_id: other.id,
    contact_name: "Other",
    email: other.email,
    locale: "ar",
    currency: "USD",
    country: "IQ",
    status: "ACTIVE",
  });
  customerId = customer.id;

  profiles.byId.set(ownerId, { id: ownerId, role: "OWNER", status: "ACTIVE" });
  profiles.byId.set(partnerId, { id: partnerId, role: "PARTNER", status: "ACTIVE" });
  profiles.byId.set(clientId, { id: clientId, role: "CLIENT", status: "ACTIVE" });
  profiles.byId.set(otherClientId, { id: otherClientId, role: "CLIENT", status: "ACTIVE" });
});

describe("ads API routes", () => {
  it("refuses anonymous callers and clients on staff actions", async () => {
    expect((await listAds(req(null))).status).toBe(401);
    expect((await createAds(req(null, { customerId, totalBudgetUsd: 100 }, "POST"))).status).toBe(401);
    expect((await createAds(req(clientId, { customerId, totalBudgetUsd: 100 }, "POST"))).status).toBe(403);
    expect((await launchAds(req(null, {}, "POST"), ctx("x"))).status).toBe(401);
  });

  it("creates a draft, hides it from the client, and lets only the owner approve", async () => {
    const created = await createAds(
      req(
        ownerId,
        {
          customerId,
          businessCategory: "LOCAL_RETAIL",
          objective: "MESSAGES",
          brief: "متجر محلي",
          totalBudgetUsd: 240,
          durationDays: 24,
        },
        "POST",
      ),
    );
    expect(created.status).toBe(201);
    const body = (await created.json()) as { data: { plan: { id: string; status: string; internalNote: string | null }; liveExecution: boolean } };
    expect(body.data.plan.status).toBe("DRAFT");
    expect(body.data.liveExecution).toBe(false);
    expect(body.data.plan.internalNote).toBeNull();
    const planId = body.data.plan.id;

    const clientList = await listAds(req(clientId));
    expect(clientList.status).toBe(200);
    const listed = (await clientList.json()) as { data: { rows: { id: string }[] } };
    expect(listed.data.rows.map((row) => row.id)).not.toContain(planId);

    const clientGet = await getAds(req(clientId), ctx(planId));
    expect(clientGet.status).toBe(404);

    const otherGet = await getAds(req(otherClientId), ctx(planId));
    expect(otherGet.status).toBe(404);

    expect((await approveAds(req(partnerId, {}, "POST"), ctx(planId))).status).toBe(403);
    expect((await submitAds(req(partnerId, {}, "POST"), ctx(planId))).status).toBe(200);

    const approved = await approveAds(req(ownerId, {}, "POST"), ctx(planId));
    expect(approved.status).toBe(200);
    const approvedBody = (await approved.json()) as { data: { plan: { status: string }; liveExecution: boolean } };
    expect(approvedBody.data.plan.status).toBe("APPROVED");
    expect(approvedBody.data.liveExecution).toBe(false);

    const clientAfter = await getAds(req(clientId), ctx(planId));
    expect(clientAfter.status).toBe(200);
    const clientPlan = (await clientAfter.json()) as { data: { plan: Record<string, unknown> } };
    expect(JSON.stringify(clientPlan)).not.toContain("internalNote");
    expect(JSON.stringify(clientPlan)).not.toContain("internal_note");
  });

  it("records manual results, analyses without mutating the approved plan, and refuses launch", async () => {
    const created = await createAds(
      req(ownerId, { customerId, objective: "SALES", brief: "مبيعات", totalBudgetUsd: 150, durationDays: 15 }, "POST"),
    );
    const createdBody = (await created.json()) as { data: { plan: { id: string } } };
    const planId = createdBody.data.plan.id;
    const approvedRes = await approveAds(req(ownerId, {}, "POST"), ctx(planId));
    expect(approvedRes.status).toBe(200);
    const approvedVersion = ((await approvedRes.json()) as { data: { plan: { version: number } } }).data.plan.version;

    expect((await recordResults(req(clientId, { date: "2026-10-20", spendUsd: 10, impressions: 100 }, "POST"), ctx(planId))).status).toBe(403);

    const recorded = await recordResults(
      req(ownerId, { date: "2026-10-20", spendUsd: 25, impressions: 5000, clicks: 50, messages: 4, orders: 1 }, "POST"),
      ctx(planId),
    );
    expect(recorded.status).toBe(201);
    const recordedBody = (await recorded.json()) as { data: { actuals: { cpcMinor: number }; source: string } };
    expect(recordedBody.data.source).toBe("MANUAL");
    expect(recordedBody.data.actuals.cpcMinor).toBe(50);

    const analysed = await analyzeAds(req(ownerId, {}, "POST"), ctx(planId));
    expect(analysed.status).toBe(200);
    const analysis = (await analysed.json()) as { data: { approvedPlanUnchanged: boolean; liveExecution: boolean } };
    expect(analysis.data.approvedPlanUnchanged).toBe(true);
    expect(analysis.data.liveExecution).toBe(false);

    const launch = await launchAds(req(ownerId, {}, "POST"), ctx(planId));
    expect(launch.status).toBe(412);
    const launchBody = (await launch.json()) as { error: string };
    expect(launchBody.error).toMatch(/advisory only|disabled/i);

    const patched = await patchAds(req(ownerId, { totalBudgetUsd: 180 }, "PATCH"), ctx(planId));
    expect(patched.status).toBe(200);
    const patchBody = (await patched.json()) as { data: { plan: { status: string; version: number } } };
    expect(patchBody.data.plan.status).toBe("DRAFT");
    expect(patchBody.data.plan.version).toBeGreaterThan(approvedVersion);

    const stillApproved = await getAds(req(clientId), ctx(planId));
    const still = (await stillApproved.json()) as { data: { plan: { version: number; body: { totalBudgetMinor: number } } } };
    expect(still.data.plan.version).toBe(approvedVersion);
    expect(still.data.plan.body.totalBudgetMinor).toBe(15_000);
  });
});
