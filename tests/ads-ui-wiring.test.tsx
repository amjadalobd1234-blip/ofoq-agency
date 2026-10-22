// @vitest-environment jsdom
/**
 * The Ads Agent in the two dashboards — the wiring proof.
 *
 * The admin panel creates, submits, approves, records results and analyses
 * through the Ads API. The client portal reads approved plans only.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AdminAds } from "../src/components/admin-ads";
import { ClientDashboard } from "../src/components/client-dashboard";

interface Call {
  url: string;
  method: string;
  body: unknown;
}

const calls: Call[] = [];
let responses: Record<string, unknown> = {};
let statuses: Record<string, number> = {};

function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
      const key = `${method} ${url.split("?")[0]!}`;
      const payload = responses[key] ?? responses[url.split("?")[0]!] ?? { data: {} };
      const status = statuses[key] ?? statuses[url.split("?")[0]!] ?? 200;
      return Response.json(payload, { status, headers: { "Content-Type": "application/json" } });
    }),
  );
}

beforeEach(() => {
  calls.length = 0;
  responses = {};
  statuses = {};
  stubFetch();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const samplePlan = {
  id: "ad-1",
  code: "OFQ-AD-2026-0001",
  customerId: "c-1",
  customerName: "عميل",
  customerCompany: "متجر البصرة",
  projectId: null,
  version: 1,
  status: "DRAFT",
  summary: "خطة إعلانية استشارية",
  internalNote: "تكلفة داخلية",
  approvedAt: null,
  approvedVersion: null,
  requiresOwnerApproval: true,
  body: {
    objective: "MESSAGES",
    businessCategory: "RESTAURANT",
    durationDays: 30,
    dailyBudgetMinor: 1000,
    totalBudgetMinor: 30000,
    platforms: [{ platform: "META_ADS", percent: 50, dailyBudgetMinor: 500, totalBudgetMinor: 15000 }],
    audience: { description: "عائلات البصرة", geo: ["العراق", "البصرة"] },
    adCopy: [{ platform: "META_ADS", headline: "راسلنا واتساب", primaryText: "نرد عليك خلال الدوام", cta: "واتساب" }],
    adIdeas: [{ title: "فيديو قصير", format: "Reel", description: "لقطة للمكان" }],
    kpis: [{ key: "ctr", labelAr: "نسبة النقر", target: "1%" }],
    analysis: { business: "مطعم", audience: "عائلات", platformRationale: "ميتا أولًا" },
    disclaimerAr: "خطة استشارية",
  },
  forecasts: {
    isEstimate: true as const,
    disclaimerAr: "تقديرات",
    totals: { impressionsLow: 1000, impressionsHigh: 4000, clicksLow: 10, clicksHigh: 80 },
  },
};

describe("the admin dashboard — the ads panel", () => {
  it("creates an ads plan for a customer through the API", async () => {
    responses["GET /api/ads"] = { data: { rows: [samplePlan], total: 1 } };
    responses["POST /api/ads"] = { data: { plan: { ...samplePlan, id: "ad-2" }, liveExecution: false } };

    render(
      <AdminAds locale="ar" clients={[{ id: "c-1", name: "عميل", companyName: "متجر البصرة" }]} />,
    );

    await waitFor(() => expect(screen.getByText(/OFQ-AD-2026-0001/)).toBeTruthy());

    fireEvent.change(document.querySelector("select")!, { target: { value: "c-1" } });
    fireEvent.click(screen.getByRole("button", { name: /إعداد خطة إعلانية/ }));

    await waitFor(() => expect(calls.some((call) => call.method === "POST" && call.url === "/api/ads")).toBe(true));
    const created = calls.find((call) => call.method === "POST" && call.url === "/api/ads");
    expect(created?.body).toMatchObject({ customerId: "c-1", totalBudgetUsd: 300 });
  });

  it("approves a plan and records manual results through the API", async () => {
    responses["GET /api/ads"] = { data: { rows: [{ ...samplePlan, status: "AWAITING_APPROVAL" }], total: 1 } };
    responses["POST /api/ads/ad-1/approve"] = { data: { plan: { ...samplePlan, status: "APPROVED" }, liveExecution: false } };
    responses["POST /api/ads/ad-1/results"] = { data: { source: "MANUAL" } };

    render(
      <AdminAds locale="ar" clients={[{ id: "c-1", name: "عميل", companyName: "متجر البصرة" }]} />,
    );
    await waitFor(() => expect(screen.getByText(/OFQ-AD-2026-0001/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /اعتماد الخطة/ }));
    await waitFor(() => expect(calls.some((call) => call.url === "/api/ads/ad-1/approve")).toBe(true));
  });
});

describe("the client portal — approved ads plans", () => {
  const approvedPlan = {
    id: "ad-1",
    code: "OFQ-AD-2026-0001",
    version: 1,
    status: "APPROVED",
    summary: "خطة معتمدة",
    currency: "USD",
    body: samplePlan.body,
    forecasts: samplePlan.forecasts,
    actuals: { spendMinor: 0, impressions: 0, clicks: 0, messages: 0, orders: 0, ctr: null, cpcMinor: null },
    reports: [],
    disclaimerAr: samplePlan.body.disclaimerAr,
    disclaimerEn: "advisory",
  };

  it("loads approved ads plans from the Ads API and does not render a draft-only payload", async () => {
    responses["GET /api/dashboard"] = {
      data: {
        customer: { id: "c-1", name: "عميل", locale: "ar" },
        projects: [],
        offers: [],
        invoices: [],
        payments: [],
        subscriptions: [],
        campaigns: [],
        reports: [],
        files: [],
      },
    };
    responses["GET /api/projects"] = { data: { rows: [] } };
    responses["GET /api/ads"] = { data: { rows: [approvedPlan] } };

    render(<ClientDashboard locale="ar" />);
    await waitFor(() => expect(calls.some((call) => call.url === "/api/ads")).toBe(true));
    await waitFor(() => expect(screen.getByText(/OFQ-AD-2026-0001/)).toBeTruthy());
    expect(screen.queryByText("تكلفة داخلية")).toBeNull();
  });

  it("shows the approved plan from the dashboard RPC when /api/ads is unavailable", async () => {
    responses["GET /api/dashboard"] = {
      data: {
        customer: { id: "c-1", name: "عميل", locale: "ar" },
        projects: [],
        offers: [],
        invoices: [],
        payments: [],
        subscriptions: [],
        campaigns: [],
        adPlans: [approvedPlan],
        reports: [],
        files: [],
      },
    };
    responses["GET /api/projects"] = { data: { rows: [] } };
    statuses["GET /api/ads"] = 503;
    responses["GET /api/ads"] = { error: "DATABASE_URL is required", code: "CONFIGURATION_ERROR" };

    render(<ClientDashboard locale="ar" />);
    await waitFor(() => expect(screen.getByText(/OFQ-AD-2026-0001/)).toBeTruthy());
    expect(screen.queryByText("تكلفة داخلية")).toBeNull();
  });
});
