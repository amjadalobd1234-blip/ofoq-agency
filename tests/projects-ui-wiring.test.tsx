// @vitest-environment jsdom
/**
 * The Projects Agent in the two dashboards — the wiring proof.
 *
 * The admin panel and the client portal must talk to the real Projects API:
 * the admin panel creates, approves, updates and closes through the routes,
 * and the client portal reads the progress and the approved plan. These tests
 * render the components and assert the HTTP calls they make.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AdminProjects } from "../src/components/admin-projects";
import { ClientDashboard } from "../src/components/client-dashboard";

interface Call { url: string; method: string; body: unknown }

const calls: Call[] = [];
let responses: Record<string, unknown> = {};
/** Per-route status codes, so a test can simulate a failing endpoint. */
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

describe("the admin dashboard — the projects panel", () => {
  it("creates a project for a customer through the API", async () => {
    responses["GET /api/projects"] = {
      data: {
        rows: [
          {
            id: "p-1", code: "OFQ-P-001", title: "إدارة حسابات", titleEn: null, status: "DRAFT",
            progress: 0, customerId: "c-1", customerName: "شركة العميل", startDate: "2026-10-01",
            dueDate: "2026-11-30", riskLevel: "LOW",
            plan: { id: "pl-1", version: 1, status: "DRAFT", approvedAt: null, phases: 4, tasks: 9 },
            tasks: { total: 9, done: 0, open: 9, overdue: 0 }, daysRemaining: 12,
          },
        ],
        total: 1,
      },
    };
    responses["POST /api/projects"] = { data: { project: { id: "p-2", code: "OFQ-P-002" }, plan: null } };

    render(
      <AdminProjects
        locale="ar"
        clients={[{ id: "c-1", name: "عميل", companyName: "شركة العميل" }]}
        offers={[{ id: "o-1", code: "OFQ-O-001", customerName: "شركة العميل", status: "APPROVED" }]}
      />,
    );

    await waitFor(() => expect(screen.getByText(/OFQ-P-001/)).toBeTruthy());

    fireEvent.change(document.querySelector("select")!, { target: { value: "c-1" } });
    const titleInput = document.querySelector<HTMLInputElement>('input[type="text"]')!;
    fireEvent.change(titleInput, { target: { value: "مشروع جديد" } });
    const selects = document.querySelectorAll("select");
    fireEvent.change(selects[selects.length - 1]!, { target: { value: "seo" } });
    fireEvent.click(screen.getByText("إنشاء مشروع"));

    await waitFor(() => {
      const created = calls.find((call) => call.method === "POST" && call.url === "/api/projects");
      expect(created).toBeTruthy();
      expect(created!.body).toMatchObject({ customerId: "c-1", title: "مشروع جديد", serviceSlug: "seo" });
    });
  });

  it("approves the plan and closes the project through their own routes", async () => {
    responses["GET /api/projects"] = {
      data: {
        rows: [
          {
            id: "p-1", code: "OFQ-P-001", title: "مشروع", titleEn: null, status: "PLANNING",
            progress: 40, customerId: "c-1", customerName: "عميل", startDate: "2026-10-01",
            dueDate: "2026-11-30", riskLevel: "LOW",
            plan: { id: "pl-1", version: 2, status: "DRAFT", approvedAt: null, phases: 4, tasks: 9 },
            tasks: { total: 9, done: 3, open: 6, overdue: 1 }, daysRemaining: 4,
          },
        ],
        total: 1,
      },
    };
    responses["POST /api/projects/p-1/plan/approve"] = { data: { plan: { status: "APPROVED" } } };
    responses["POST /api/projects/p-1/close"] = { data: { status: "COMPLETED", progress: 100 } };
    responses["POST /api/projects/monitor"] = {
      data: { overdueTasks: 1, dueSoonProjects: 2, lateProjects: 0, alerts: 3 },
    };

    render(
      <AdminProjects locale="ar" clients={[{ id: "c-1", name: "عميل", companyName: null }]} offers={[]} />,
    );
    await waitFor(() => expect(screen.getByText(/OFQ-P-001/)).toBeTruthy());

    fireEvent.click(screen.getByText("اعتماد الخطة (المالك)"));
    await waitFor(() => {
      expect(calls.some((call) => call.url === "/api/projects/p-1/plan/approve" && call.method === "POST")).toBe(true);
    });

    fireEvent.click(screen.getByText("إغلاق المشروع (قرار صريح)"));
    await waitFor(() => {
      expect(calls.some((call) => call.url === "/api/projects/p-1/close" && call.method === "POST")).toBe(true);
    });

    fireEvent.click(screen.getByText("فحص التأخير والمواعيد"));
    await waitFor(() => {
      expect(calls.some((call) => call.url === "/api/projects/monitor" && call.method === "POST")).toBe(true);
    });
  });
});

describe("the client portal — the project plan", () => {
  it("shows the progress and the approved plan from the API", async () => {
    responses["GET /api/dashboard"] = {
      data: {
        customer: { id: "c-1", name: "عميل", companyName: "شركة العميل", email: null, locale: "ar" },
        projects: [
          {
            id: "p-1", code: "OFQ-P-001", title: "إدارة حسابات التواصل", titleEn: "Social media",
            status: "IN_PROGRESS", progress: 0, dueDate: "2026-11-30", tasks: [],
          },
        ],
        offers: [], invoices: [], payments: [], subscriptions: [], campaigns: [], reports: [], files: [],
      },
    };
    responses["GET /api/projects"] = {
      data: {
        rows: [
          {
            id: "p-1", code: "OFQ-P-001", title: "إدارة حسابات التواصل", status: "IN_PROGRESS",
            progress: 50, dueDate: "2026-11-30", daysRemaining: 10,
            plan: { version: 1, status: "APPROVED", approvedAt: "2026-10-05T00:00:00.000Z" },
            tasks: { total: 4, done: 2, open: 2 },
          },
        ],
        total: 1,
      },
    };
    responses["GET /api/projects/p-1"] = {
      data: {
        project: {
          id: "p-1", code: "OFQ-P-001", title: "إدارة حسابات التواصل", status: "IN_PROGRESS",
          progress: 50, dueDate: "2026-11-30", daysRemaining: 10,
        },
        plan: {
          version: 1, status: "APPROVED", approvedAt: "2026-10-05T00:00:00.000Z",
          summary: "خطة معتمدة من المالك",
          phases: [
            {
              key: "PREPARATION", title: "التحضير والتخطيط", dueDate: "2026-10-20",
              tasks: [
                { title: "إعداد خطة النشر الأسبوعية", status: "DONE", dueDate: "2026-10-10" },
                { title: "تصميم قوالب المنشورات", status: "IN_PROGRESS", dueDate: "2026-10-18" },
              ],
            },
          ],
        },
        tasks: [
          { id: "t-1", title: "إعداد خطة النشر الأسبوعية", status: "DONE", dueDate: "2026-10-10" },
        ],
      },
    };

    render(<ClientDashboard locale="ar" />);

    await waitFor(() => expect(screen.getByText(/OFQ-P-001/)).toBeTruthy());
    // The progress comes from the Projects API, not from the dashboard payload.
    await waitFor(() => expect(screen.getByText("50%")).toBeTruthy());

    fireEvent.click(screen.getByText("عرض الخطة والمراحل"));
    await waitFor(() => expect(screen.getByText("التحضير والتخطيط")).toBeTruthy());
    expect(screen.getByText("إعداد خطة النشر الأسبوعية")).toBeTruthy();
    expect(screen.getByText("خطة معتمدة من المالك")).toBeTruthy();

    // The client portal never asks for anything but its own projects.
    const listCall = calls.find((call) => call.url === "/api/projects");
    expect(listCall).toBeTruthy();
  });

  it("shows the approved plan from the Supabase payload when the local API is unavailable", async () => {
    // The production deployment (Cloudflare/Netlify + Supabase) has no
    // DATABASE_URL: the local Projects API answers 503 and the portal keeps
    // working from the dashboard RPC — the approved plan included.
    statuses["GET /api/projects"] = 503;
    statuses["GET /api/projects/p-1"] = 503;
    responses["GET /api/dashboard"] = {
      data: {
        customer: { id: "c-1", name: "عميل", companyName: "شركة العميل", email: null, locale: "ar" },
        projects: [
          {
            id: "p-1", code: "OFQ-P-001", title: "إدارة حسابات التواصل", titleEn: "Social media",
            status: "IN_PROGRESS", progress: 50, dueDate: "2026-11-30", tasks: [],
            plan: {
              version: 1, status: "APPROVED", approvedAt: "2026-10-05T00:00:00.000Z",
              summary: "خطة معتمدة من المالك",
              phases: [
                {
                  key: "PREPARATION", title: "التحضير والتخطيط", dueDate: "2026-10-20",
                  tasks: [
                    { title: "إعداد خطة النشر الأسبوعية", status: "DONE", dueDate: "2026-10-10" },
                  ],
                },
              ],
            },
          },
        ],
        offers: [], invoices: [], payments: [], subscriptions: [], campaigns: [], reports: [], files: [],
      },
    };

    render(<ClientDashboard locale="ar" />);

    await waitFor(() => expect(screen.getByText(/OFQ-P-001/)).toBeTruthy());
    // The progress comes from the dashboard payload when the local API is down.
    await waitFor(() => expect(screen.getByText("50%")).toBeTruthy());
    // The plan line shows the approved version.
    await waitFor(() => expect(screen.getByText(/الخطة: v1/)).toBeTruthy());

    fireEvent.click(screen.getByText("عرض الخطة والمراحل"));
    await waitFor(() => expect(screen.getByText("التحضير والتخطيط")).toBeTruthy());
    expect(screen.getByText("إعداد خطة النشر الأسبوعية")).toBeTruthy();
    expect(screen.getByText("خطة معتمدة من المالك")).toBeTruthy();

    // The detail route was not needed: the plan came from the RPC payload.
    expect(calls.some((call) => call.url.startsWith("/api/projects/p-1"))).toBe(false);
  });
});
