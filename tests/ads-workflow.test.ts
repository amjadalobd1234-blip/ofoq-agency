import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The Ads Agent full cycle over HTTP:
 * client info → draft plan → owner review → approval → client view →
 * manual results → analysis and recommendations.
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
const { GET: getAds } = await import("../src/app/api/ads/[id]/route");
const { POST: submitAds } = await import("../src/app/api/ads/[id]/submit/route");
const { POST: approveAds } = await import("../src/app/api/ads/[id]/approve/route");
const { POST: recordResults } = await import("../src/app/api/ads/[id]/results/route");
const { POST: analyzeAds } = await import("../src/app/api/ads/[id]/analyze/route");
const { POST: publishReport } = await import("../src/app/api/ads/[id]/reports/[reportId]/publish/route");
const { POST: launchAds } = await import("../src/app/api/ads/[id]/launch/route");

const { createCustomer } = await import("../src/lib/repositories/customers.repo");
const { createUser } = await import("../src/lib/repositories/identity.repo");

function req(userId: string, body?: unknown, method = "GET", path = "/api/ads"): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "Content-Type": "application/json", "x-test-user": userId },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const reportCtx = (id: string, reportId: string) => ({ params: Promise.resolve({ id, reportId }) });

let ownerId = "";
let clientId = "";
let customerId = "";

beforeAll(async () => {
  const owner = await createUser({ email: "ads-flow-owner@example.test", name: "Owner", role: "OWNER" });
  const client = await createUser({ email: "ads-flow-client@example.test", name: "Client", role: "CLIENT" });
  ownerId = owner.id;
  clientId = client.id;
  const customer = await createCustomer({
    user_id: client.id,
    contact_name: "عميل الدورة",
    company_name: "شركة الأفق التجريبية",
    email: client.email,
    locale: "ar",
    currency: "USD",
    country: "IQ",
    city: "البصرة",
    status: "ACTIVE",
  });
  customerId = customer.id;
  profiles.byId.set(ownerId, { id: ownerId, role: "OWNER", status: "ACTIVE" });
  profiles.byId.set(clientId, { id: clientId, role: "CLIENT", status: "ACTIVE" });
});

describe("ads agent — full HTTP cycle", () => {
  it("runs information → plan → review → approval → client view → results → analysis", async () => {
    const created = await createAds(
      req(
        ownerId,
        {
          customerId,
          businessCategory: "RESTAURANT",
          objective: "MESSAGES",
          brief: "مطعم في البصرة يريد رسائل واتساب من أهل المحافظة",
          audience: "عائلات في البصرة",
          geo: ["العراق", "البصرة"],
          totalBudgetUsd: 360,
          durationDays: 30,
        },
        "POST",
      ),
    );
    expect(created.status).toBe(201);
    const draft = (await created.json()) as {
      data: {
        plan: {
          id: string;
          status: string;
          body: { currency: string; platforms: { totalBudgetMinor: number }[]; totalBudgetMinor: number; dailyBudgetMinor: number };
          forecasts: { isEstimate: boolean };
        };
        liveExecution: boolean;
      };
    };
    expect(draft.data.plan.status).toBe("DRAFT");
    expect(draft.data.liveExecution).toBe(false);
    expect(draft.data.plan.body.currency).toBe("USD");
    expect(draft.data.plan.body.platforms.reduce((total, row) => total + row.totalBudgetMinor, 0)).toBe(
      draft.data.plan.body.totalBudgetMinor,
    );
    expect(draft.data.plan.forecasts.isEstimate).toBe(true);
    const planId = draft.data.plan.id;

    expect((await listAds(req(clientId))).status).toBe(200);
    const before = (await (await listAds(req(clientId))).json()) as { data: { rows: { id: string }[] } };
    expect(before.data.rows.map((row) => row.id)).not.toContain(planId);

    expect((await submitAds(req(ownerId, {}, "POST"), ctx(planId))).status).toBe(200);
    expect((await approveAds(req(ownerId, {}, "POST"), ctx(planId))).status).toBe(200);

    const clientPlan = await getAds(req(clientId), ctx(planId));
    expect(clientPlan.status).toBe(200);
    const visible = (await clientPlan.json()) as { data: { plan: { status: string; body: { adCopy: unknown[] } } } };
    expect(visible.data.plan.status).toBe("APPROVED");
    expect(visible.data.plan.body.adCopy.length).toBeGreaterThan(0);

    const results = await recordResults(
      req(ownerId, { date: "2026-10-21", spendUsd: 12, impressions: 3000, clicks: 30, messages: 5, orders: 0 }, "POST"),
      ctx(planId),
    );
    expect(results.status).toBe(201);

    const analysed = await analyzeAds(req(ownerId, {}, "POST"), ctx(planId));
    expect(analysed.status).toBe(200);
    const analysis = (await analysed.json()) as {
      data: { report: { id: string; status: string }; approvedPlanUnchanged: boolean; liveExecution: boolean };
    };
    expect(analysis.data.approvedPlanUnchanged).toBe(true);
    expect(analysis.data.liveExecution).toBe(false);
    expect(analysis.data.report.status).toBe("DRAFT");

    expect(
      (await publishReport(req(ownerId, {}, "POST"), reportCtx(planId, analysis.data.report.id))).status,
    ).toBe(200);

    const afterPublish = (await (await getAds(req(clientId), ctx(planId))).json()) as {
      data: { plan: { reports: { id: string }[]; actuals: { messages: number } } };
    };
    expect(afterPublish.data.plan.reports.map((row) => row.id)).toContain(analysis.data.report.id);
    expect(afterPublish.data.plan.actuals.messages).toBe(5);

    expect((await launchAds(req(ownerId, {}, "POST"), ctx(planId))).status).toBe(412);
  });
});
