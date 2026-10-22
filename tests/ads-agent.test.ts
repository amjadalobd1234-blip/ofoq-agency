import { beforeAll, describe, expect, it } from "vitest";

import {
  buildAdPlanDocument,
  buildForecasts,
  computeAdKpis,
  recommendImprovements,
  recommendPlatformPercents,
  splitBudgetAcrossPlatforms,
} from "@/lib/agents/specialists/ads.agent";
import { ForbiddenError, NotFoundError } from "@/lib/core/errors";
import type { Actor } from "@/lib/auth/permissions";
import { createCustomer } from "@/lib/repositories/customers.repo";
import { createUser } from "@/lib/repositories/identity.repo";
import { findAdPlanById, listAdPlanResults } from "@/lib/repositories/ads.repo";
import {
  analyzeAdPlan,
  approveAdPlan,
  createAdPlanForCustomer,
  forbidLiveAdsExecution,
  getClientAdPlan,
  listClientAdPlans,
  recordAdPlanResult,
  saveAdPlanDraft,
  submitAdPlanForApproval,
} from "@/lib/services/ad-plans.service";

let owner: Actor;
let partner: Actor;
let client: Actor;
let otherClient: Actor;
let customerId = "";
let otherCustomerId = "";

beforeAll(async () => {
  const ownerUser = await createUser({ email: "ads-owner@example.test", name: "Owner", role: "OWNER" });
  const partnerUser = await createUser({ email: "ads-partner@example.test", name: "Partner", role: "PARTNER" });
  const clientUser = await createUser({ email: "ads-client@example.test", name: "Client", role: "CLIENT" });
  const otherUser = await createUser({ email: "ads-other@example.test", name: "Other", role: "CLIENT" });
  owner = { id: ownerUser.id, role: "OWNER" };
  partner = { id: partnerUser.id, role: "PARTNER" };

  const customer = await createCustomer({
    user_id: clientUser.id,
    contact_name: "عميل الإعلانات",
    company_name: "متجر البصرة",
    email: clientUser.email,
    locale: "ar",
    currency: "USD",
    country: "IQ",
    city: "البصرة",
    status: "ACTIVE",
  });
  const otherCustomer = await createCustomer({
    user_id: otherUser.id,
    contact_name: "عميل آخر",
    email: otherUser.email,
    locale: "ar",
    currency: "USD",
    country: "IQ",
    status: "ACTIVE",
  });
  customerId = customer.id;
  otherCustomerId = otherCustomer.id;
  client = { id: clientUser.id, role: "CLIENT", customerId };
  otherClient = { id: otherUser.id, role: "CLIENT", customerId: otherCustomerId };
});

describe("Ads Agent — plan math", () => {
  it("splits the USD budget so platform totals and dailies sum exactly", () => {
    const percents = recommendPlatformPercents("ECOMMERCE");
    expect(percents.reduce((total, row) => total + row.percent, 0)).toBe(100);

    const { dailyBudgetMinor, allocations } = splitBudgetAcrossPlatforms(30_000, 30, percents);
    expect(allocations.reduce((total, row) => total + row.totalBudgetMinor, 0)).toBe(30_000);
    expect(allocations.reduce((total, row) => total + row.dailyBudgetMinor, 0)).toBe(dailyBudgetMinor);
    expect(dailyBudgetMinor).toBe(1_000);
  });

  it("picks Meta, Google and TikTok from the business category", () => {
    const restaurant = recommendPlatformPercents("RESTAURANT").map((row) => row.platform);
    expect(restaurant).toContain("META_ADS");
    expect(restaurant).toContain("TIKTOK");

    const professional = recommendPlatformPercents("PROFESSIONAL");
    expect(professional.find((row) => row.platform === "TIKTOK")).toBeUndefined();
    expect(professional.reduce((total, row) => total + row.percent, 0)).toBe(100);
  });

  it("labels forecasts as estimates and never as a guarantee", () => {
    const built = buildAdPlanDocument({
      businessCategory: "RESTAURANT",
      objective: "MESSAGES",
      brief: "مطعم في البصرة يريد رسائل واتساب",
      totalBudgetMinor: 50_000,
      durationDays: 30,
      locale: "ar",
      brandName: "مطعم دجلة",
      city: "البصرة",
    });
    expect(built.body.currency).toBe("USD");
    expect(built.body.disclaimerAr).toMatch(/استشارية|لا يتصل|لا يُطلق/);
    expect(built.forecasts.isEstimate).toBe(true);
    expect(built.forecasts.disclaimerAr).toMatch(/تقديرية|ليست نتائج مضمونة/);
    expect(built.body.adCopy.length).toBeGreaterThan(0);
    expect(built.body.adCopy[0]!.primaryText.length).toBeGreaterThan(10);
    const rebuilt = buildForecasts(built.body.platforms, built.body.objective);
    expect(rebuilt.totals.impressionsHigh).toBeGreaterThanOrEqual(rebuilt.totals.impressionsLow);
  });
});

describe("Ads Agent — workflow", () => {
  it("saves a DRAFT, hides it from the client, then shows it after owner approval", async () => {
    const created = await createAdPlanForCustomer(
      {
        customerId,
        businessCategory: "RESTAURANT",
        objective: "MESSAGES",
        brief: "مطعم عائلي في البصرة، الهدف رسائل واتساب",
        totalBudgetUsd: 300,
        durationDays: 30,
      },
      owner,
    );
    expect(created.status).toBe("DRAFT");
    expect(created.requiresOwnerApproval).toBe(true);
    expect(created.liveExecution).toBe(false);
    expect(created.body?.currency).toBe("USD");
    expect(created.internalNote).toBeNull();
    expect(created.body?.platforms.reduce((total, row) => total + row.totalBudgetMinor, 0)).toBe(
      created.body?.totalBudgetMinor,
    );

    const hidden = await listClientAdPlans(client);
    expect(hidden.find((row) => row.id === created.id)).toBeUndefined();

    await expect(getClientAdPlan(created.id, client)).rejects.toBeInstanceOf(NotFoundError);

    await expect(approveAdPlan(created.id, partner)).rejects.toBeInstanceOf(ForbiddenError);

    await submitAdPlanForApproval(created.id, partner);
    const approved = await approveAdPlan(created.id, owner);
    expect(approved.status).toBe("APPROVED");
    expect(approved.liveExecution).toBe(false);

    const visible = await listClientAdPlans(client);
    expect(visible.map((row) => row.id)).toContain(created.id);
    expect(JSON.stringify(visible)).not.toContain("internalNote");
    expect(JSON.stringify(visible)).not.toMatch(/internal_note/);

    const otherView = await listClientAdPlans(otherClient);
    expect(otherView.map((row) => row.id)).not.toContain(created.id);
    await expect(getClientAdPlan(created.id, otherClient)).rejects.toThrow(/not found/i);
  });

  it("records manual results, computes KPIs, and does not change the approved plan", async () => {
    const created = await createAdPlanForCustomer(
      {
        customerId,
        businessCategory: "ECOMMERCE",
        objective: "SALES",
        brief: "متجر إلكتروني للملابس",
        totalBudgetUsd: 450,
        durationDays: 30,
      },
      owner,
    );
    await approveAdPlan(created.id, owner);

    const recorded = await recordAdPlanResult(created.id, owner, {
      date: "2026-10-20",
      spendUsd: 40,
      impressions: 8000,
      clicks: 40,
      messages: 6,
      orders: 2,
    });
    expect(recorded.result.source).toBe("MANUAL");
    expect(recorded.actuals.spendMinor).toBe(4_000);
    expect(recorded.actuals.ctr).toBe(0.5);
    expect(recorded.actuals.cpcMinor).toBe(100);
    expect(recorded.actuals.cpaMinor).toBe(2_000);

    const before = await findAdPlanById(created.id);
    const analysis = await analyzeAdPlan(created.id, owner);
    expect(analysis.approvedPlanUnchanged).toBe(true);
    expect(analysis.liveExecution).toBe(false);
    expect(analysis.report.status).toBe("DRAFT");
    expect(analysis.recommendations.length).toBeGreaterThan(0);

    const after = await findAdPlanById(created.id);
    expect(after?.status).toBe("APPROVED");
    expect(after?.body).toBe(before?.body);
    expect(after?.version).toBe(before?.version);

    const clientView = await getClientAdPlan(created.id, client);
    expect(clientView.actuals.orders).toBe(2);
    expect(clientView.reports).toEqual([]);
    expect(JSON.stringify(clientView)).not.toContain("internalNote");
  });

  it("opens a new DRAFT after editing an approved plan, leaving the approved copy in place", async () => {
    const created = await createAdPlanForCustomer(
      {
        customerId,
        businessCategory: "SERVICES",
        objective: "LEADS",
        brief: "خدمة صيانة",
        totalBudgetUsd: 200,
        durationDays: 20,
      },
      owner,
    );
    const approved = await approveAdPlan(created.id, owner);
    const edited = await saveAdPlanDraft(created.id, owner, { totalBudgetUsd: 250, reviewNote: "رفع الميزانية المقترحة" });
    expect(edited.status).toBe("DRAFT");
    expect(edited.id).not.toBe(created.id);
    expect(edited.version).toBeGreaterThan(approved.version);

    const stillApproved = await getClientAdPlan(created.id, client);
    expect(stillApproved.version).toBe(approved.version);
    expect(stillApproved.body.totalBudgetMinor).toBe(20_000);
  });

  it("computes KPIs from entered rows only and never invents performance", () => {
    const kpis = computeAdKpis([]);
    expect(kpis.spendMinor).toBe(0);
    expect(kpis.impressions).toBe(0);
    expect(kpis.ctr).toBeNull();
    const empty = recommendImprovements(
      buildAdPlanDocument({
        businessCategory: "OTHER",
        objective: "TRAFFIC",
        brief: "",
        totalBudgetMinor: 10_000,
        durationDays: 10,
        locale: "ar",
      }).body,
      kpis,
    );
    expect(empty[0]?.key).toBe("no_data");
  });

  it("refuses live ads execution", () => {
    expect(() => forbidLiveAdsExecution()).toThrow(/advisory only|disabled/i);
    expect(() => forbidLiveAdsExecution()).toBeTruthy();
  });

  it("does not let a client record results or analyse", async () => {
    const created = await createAdPlanForCustomer(
      {
        customerId,
        businessCategory: "OTHER",
        objective: "AWARENESS",
        brief: "حملة وعي",
        totalBudgetUsd: 100,
        durationDays: 10,
      },
      owner,
    );
    await approveAdPlan(created.id, owner);
    await expect(
      recordAdPlanResult(created.id, client, { date: "2026-10-21", spendUsd: 10, impressions: 100 }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(analyzeAdPlan(created.id, client)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await listAdPlanResults(created.id)).toEqual([]);
  });
});
