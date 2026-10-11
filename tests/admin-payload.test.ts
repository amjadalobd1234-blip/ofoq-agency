import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  normalizeAdminAlertDetails,
  normalizeAdminAlertList,
  normalizeAdminDashboard,
} from "../src/lib/admin/payload";

const rootDir = path.resolve(__dirname, "..");
const dashboardComponent = fs.readFileSync(path.join(rootDir, "src", "components", "admin-dashboard.tsx"), "utf8");
const listComponent = fs.readFileSync(path.join(rootDir, "src", "components", "admin-alert-list.tsx"), "utf8");
const detailComponent = fs.readFileSync(path.join(rootDir, "src", "components", "admin-alert-detail.tsx"), "utf8");
const errorBoundary = fs.readFileSync(path.join(rootDir, "src", "app", "admin", "error.tsx"), "utf8");

/**
 * Regression cover for the "/admin → Application error: a client-side
 * exception has occurred" crash.
 *
 * The admin screens used to cast the RPC response with `as AdminData` and then
 * read `data.totals.criticalAlerts` / `data.integrations.googleAds` straight
 * out of the render tree. When the deployed `ofoq_admin_dashboard` RPC returned
 * a shape that did not carry those fields, React threw during render, the tree
 * unmounted, and — with no error boundary under `/admin` — Next.js replaced the
 * page with its generic production document.
 */
describe("admin payload normalisation", () => {
  it("survives a completely empty dashboard payload", () => {
    for (const raw of [undefined, null, {}, { data: null }, "boom", 42, []]) {
      const data = normalizeAdminDashboard(raw);
      expect(data.totals.customers).toBe(0);
      expect(data.totals.urgentAlerts).toBe(0);
      expect(data.clients).toEqual([]);
      expect(data.alerts).toEqual([]);
      expect(data.leadRequests).toEqual([]);
      expect(data.financials.collected30d).toEqual([]);
      expect(data.integrations.googleAds.status).toBe("NOT_CONNECTED");
      expect(data.integrations.whatsapp.status).toBe("DISABLED");
      expect(data.integrations.payments.status).toBe("MANUAL_ONLY");
    }
  });

  it("fills in totals and integrations when the deployed RPC predates them", () => {
    // The exact regression: an older ofoq_admin_dashboard with no `integrations`
    // key and no critical/new-lead counters.
    const legacy = {
      generatedAt: "2026-10-11T00:00:00.000Z",
      totals: { customers: 3, urgentAlerts: 7 },
      clients: [],
      requests: [],
      projects: [],
      campaigns: [],
      reports: [],
      alerts: [],
      agentActions: [],
      financials: {},
    };

    const data = normalizeAdminDashboard(legacy);

    expect(data.totals.customers).toBe(3);
    expect(data.totals.urgentAlerts).toBe(7);
    // Absent counters stay absent so the component's `??` fallbacks still apply.
    expect(data.totals.criticalAlerts).toBeUndefined();
    expect(data.totals.newLeads).toBeUndefined();
    expect(data.totals.criticalAlerts ?? data.totals.urgentAlerts).toBe(7);
    expect(data.integrations.googleAds.status).toBe("NOT_CONNECTED");
  });

  it("keeps counters that are present and coerces stringified ones", () => {
    const data = normalizeAdminDashboard({
      totals: { customers: "12", criticalAlerts: 4, newLeads: "2", pendingAgentActions: null },
    });
    expect(data.totals.customers).toBe(12);
    expect(data.totals.criticalAlerts).toBe(4);
    expect(data.totals.newLeads).toBe(2);
    expect(data.totals.pendingAgentActions).toBe(0);
  });

  it("never yields null severity or status, which are interpolated into class names", () => {
    const data = normalizeAdminDashboard({
      alerts: [{ id: "a1", severity: null, status: null, titleAr: "طلب" }],
      leadRequests: [{ id: "a2", severity: undefined, status: undefined, category: "NEW_LEAD" }],
    });
    expect(data.alerts[0]!.severity).toBe("INFO");
    expect(data.alerts[0]!.status).toBe("NEW");
    expect(data.leadRequests[0]!.severity).toBe("INFO");
    expect(data.leadRequests[0]!.status).toBe("NEW");
  });

  it("preserves bigint money columns that arrive as numeric strings", () => {
    const data = normalizeAdminDashboard({
      requests: [{ id: "o1", totalMinor: "9007199254740993", currency: "IQD" }],
      campaigns: [{ id: "g1", spentMinor: 12345 }],
      financials: { collected30d: [{ currency: "USD", totalMinor: "50000" }] },
    });
    expect(data.requests[0]!.totalMinor).toBe("9007199254740993");
    expect(data.campaigns[0]!.spentMinor).toBe(12345);
    expect(data.financials.collected30d[0]!.totalMinor).toBe("50000");
  });

  it("normalises an alert list that is missing or malformed", () => {
    expect(normalizeAdminAlertList(undefined)).toEqual({
      items: [], total: 0, filter: "ALL", limit: 50, offset: 0,
    });
    const list = normalizeAdminAlertList({ items: { not: "an array" }, total: null });
    expect(list.items).toEqual([]);
    expect(list.total).toBe(0);
  });

  it("normalises alert details so activities and messages always have lengths", () => {
    const details = normalizeAdminAlertDetails({ alert: { id: "a1" } });
    expect(details.messages).toEqual([]);
    expect(details.activities).toEqual([]);
    expect(details.conversation).toBeNull();
    expect(details.client).toBeNull();
    expect(details.alert.severity).toBe("INFO");
    expect(details.alert.updatedAt).toBe("");
  });
});

describe("admin resilience wiring", () => {
  it("no longer casts API payloads with `as`", () => {
    // An `as` cast is compile-time only; it cannot protect a render-time access.
    expect(dashboardComponent).not.toMatch(/as AdminData/);
    expect(dashboardComponent).toContain("normalizeAdminDashboard(payload.data)");
    expect(listComponent).toContain("normalizeAdminAlertList(payload.data)");
    expect(detailComponent).toContain("normalizeAdminAlertDetails(payload.data)");
    expect(detailComponent).toContain("normalizeAdminAlertDetails(responseBody.data)");
  });

  it("ships an error boundary under /admin that shows the real error", () => {
    expect(errorBoundary).toContain('"use client"');
    expect(errorBoundary).toContain("error.message");
    expect(errorBoundary).toContain("error.digest");
    expect(errorBoundary).toContain("onClick={reset}");
    // A boundary that imports server-only code would itself throw while handling
    // the very error it exists to report.
    const imports = errorBoundary.match(/^import .*$/gm)?.join("\n") ?? "";
    expect(imports).not.toContain("next/headers");
    expect(imports).not.toContain("@/lib/supabase/");
    expect(imports).not.toContain("@/lib/i18n\"");
  });
});