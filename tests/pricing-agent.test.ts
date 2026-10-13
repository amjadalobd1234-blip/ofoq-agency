import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  ADS_PLANNING_ASSUMPTIONS,
  BUDGET_BANDS,
  PRICE_MULTIPLIERS,
  SERVICES,
  TARGETING_FACTORS,
  adDaysForBudget,
  calculateServiceEstimate,
  classifyBudget,
  estimateAdsPerformance,
  formatCount,
  platformScopeForBudget,
  spreadRange,
  type PricingInput,
} from "../src/lib/agents/pricing-agent";
import {
  SERVICE_REQUEST_BASIC_STEPS,
  SERVICE_REQUEST_QUESTIONS,
  SERVICE_REQUEST_STEPS,
  answerServiceRequest,
  createServiceRequestState,
  isServiceRequestComplete,
  serviceRequestEstimate,
  serviceRequestSummary,
} from "../src/lib/agents/service-request";

const BASE_INPUT: PricingInput = {
  type: "ads",
  size: "medium",
  budget: "under_200",
  targeting: "iraq_all",
};

function estimate(overrides: Partial<PricingInput> = {}) {
  return calculateServiceEstimate({ ...BASE_INPUT, ...overrides });
}

describe("pricing agent — the four basic questions, budget-derived scope and honest ad ranges", () => {
  it("runs the four basic questions in the requested order", () => {
    expect(SERVICE_REQUEST_BASIC_STEPS).toEqual(["TYPE", "SIZE", "BUDGET", "TARGETING"]);
    // The summary follows the four questions, then the contact channel.
    expect(SERVICE_REQUEST_STEPS.slice(0, 6)).toEqual(["TYPE", "SIZE", "BUDGET", "TARGETING", "SUMMARY", "CONTACT"]);
    // Platforms, deadline, project type and price range are no longer asked.
    expect(Object.keys(SERVICE_REQUEST_QUESTIONS)).toEqual(["TYPE", "SIZE", "BUDGET", "TARGETING", "CONTACT"]);
    for (const removed of ["PLATFORMS", "DEADLINE", "BUSINESS_TYPE", "PRICE_RANGE"]) {
      expect(SERVICE_REQUEST_STEPS).not.toContain(removed);
    }
    // Each question carries the options the client may pick from.
    expect(SERVICE_REQUEST_QUESTIONS.TYPE.options.map((option) => option.id)).toEqual([
      "design",
      "ads",
      "social_media",
      "content",
      "seo",
      "other",
    ]);

    // The guided flow really walks TYPE → SIZE → BUDGET → TARGETING → SUMMARY.
    let state = createServiceRequestState();
    expect(state.step).toBe("TYPE");
    state = answerServiceRequest(state, "ads", "2026-10-12T06:00:00.000Z");
    expect(state.step).toBe("SIZE");
    state = answerServiceRequest(state, "medium", "2026-10-12T06:01:00.000Z");
    expect(state.step).toBe("BUDGET");
    state = answerServiceRequest(state, "under_200", "2026-10-12T06:02:00.000Z");
    expect(state.step).toBe("TARGETING");
    state = answerServiceRequest(state, "iraq_all", "2026-10-12T06:03:00.000Z");
    expect(state.step).toBe("SUMMARY");
    expect(isServiceRequestComplete(state.answers)).toBe(true);
    expect(state.answerLog.map((event) => event.step)).toEqual(["TYPE", "SIZE", "BUDGET", "TARGETING"]);
  });

  it("infers the number of platforms from the budget instead of asking", () => {
    expect(platformScopeForBudget(200)).toBe("single");
    expect(platformScopeForBudget(500)).toBe("multiple");
    expect(platformScopeForBudget(1_500)).toBe("multiple");

    expect(estimate({ budget: "under_200" }).platforms).toBe("single");
    expect(estimate({ budget: "200_500" }).platforms).toBe("multiple");
    // Several platforms cost more: the scope multiplier is applied to the quote.
    const single = estimate({ type: "ads", budget: "under_200" });
    const multiple = estimate({ type: "ads", budget: "200_500", size: "medium" });
    expect([single.minPrice, single.maxPrice]).toEqual([300, 1_500]);
    expect([multiple.minPrice, multiple.maxPrice]).toEqual([390, 1_950]);
    expect(PRICE_MULTIPLIERS.platforms).toEqual({ single: 1, multiple: 1.3 });
  });

  it("gives $200 on iraq_all the 37,000–69,000 impression range — not the old 4,000–8,000", () => {
    const result = estimate({ type: "ads", budget: "under_200", targeting: "iraq_all" });
    expect(result.expectedReach).toEqual([37_000, 69_000]);
    expect(result.expectedVisits).toEqual([370, 690]);
    expect(result.expectedLeads).toEqual([9, 17]);
    expect(estimateAdsPerformance(200, "iraq_all").impressions).toEqual([37_000, 69_000]);

    // The scaling is linear in the budget: no artificial conservatism.
    expect(estimateAdsPerformance(200, "iraq_all").impressions[1]).toBeGreaterThan(8_000 * 4);
  });

  it("keeps the reference ranges for $500 and $1,000", () => {
    expect(estimateAdsPerformance(500, "iraq_all").impressions).toEqual([92_000, 172_000]);
    expect(estimateAdsPerformance(1_000, "iraq_all").impressions).toEqual([185_000, 345_000]);
    // Half the budget, half the reach — the same maths at every level.
    expect(estimateAdsPerformance(1_500, "iraq_all").impressions).toEqual([278_000, 517_000]);
  });

  it("orders every published range from the smallest to the largest value", () => {
    for (const budget of [200, 500, 1_000, 1_500, 3_000]) {
      for (const targeting of ["iraq_all", "baghdad", "gulf"] as const) {
        const performance = estimateAdsPerformance(budget, targeting);
        for (const [min, max] of [performance.impressions, performance.visits, performance.leads]) {
          expect(min).toBeLessThanOrEqual(max);
        }
      }
    }

    // The client-facing message prints the values smallest first, always.
    const body = serviceRequestEstimate({ type: "ads", size: "medium", budget: "under_200", targeting: "iraq_all" }, "ar");
    const impressions = /• الظهور: ~([\d,]+)-([\d,]+)/.exec(body);
    expect(impressions).not.toBeNull();
    expect(Number(impressions![1]!.replace(/,/g, ""))).toBeLessThan(Number(impressions![2]!.replace(/,/g, "")));
    expect(body).toContain("• الظهور: ~37,000-69,000");
  });

  it("never uses the old «صريحين معك» wording and says «تغطي» instead", () => {
    const body = serviceRequestEstimate({ type: "ads", size: "medium", budget: "under_200", targeting: "iraq_all" }, "ar");
    expect(body).toContain("💡 تغطي 16 يوم إعلان فعّال");
    expect(body).not.toContain("صريحين");
    for (const file of ["src/lib/agents/pricing-agent.ts", "src/lib/agents/service-request.ts", "src/components/assistant-chat.tsx"]) {
      expect(readFileSync(file, "utf8")).not.toContain("صريحين معك");
    }
  });

  it("follows the documented expected-results formulas", () => {
    expect(ADS_PLANNING_ASSUMPTIONS).toMatchObject({
      cpm: 3,
      clickRate: 0.01,
      conversionRate: 0.025,
      spreadLow: 0.7,
      spreadHigh: 1.3,
      effectiveSpendShare: 0.8,
    });

    const budget = 200;
    const target = TARGETING_FACTORS.iraq_all;
    const effectiveCpm = ADS_PLANNING_ASSUMPTIONS.cpm * target.cpm; // 3
    const effectiveBudget = budget * ADS_PLANNING_ASSUMPTIONS.effectiveSpendShare; // 160
    const impressions = (effectiveBudget / effectiveCpm) * 1_000 * target.reach * ADS_PLANNING_ASSUMPTIONS.deliveryEfficiency;
    const visits = impressions * ADS_PLANNING_ASSUMPTIONS.clickRate;
    const leads = visits * ADS_PLANNING_ASSUMPTIONS.conversionRate;

    expect(estimateAdsPerformance(200, "iraq_all")).toEqual({
      impressions: spreadRange(impressions, 1_000),
      visits: spreadRange(visits, 10),
      leads: spreadRange(leads, 1),
    });
    expect(estimateAdsPerformance(200, "iraq_all").impressions).toEqual([37_000, 69_000]);
    // Basra and the Gulf keep their own reach/CPM factors.
    expect(TARGETING_FACTORS.basra.reach).toBe(0.12);
    expect(TARGETING_FACTORS.gulf.cpm).toBe(4);
    expect(estimateAdsPerformance(200, "gulf").impressions[0]).toBeLessThan(37_000);
  });

  it("prices every service from the official table with the size multiplier", () => {
    expect(SERVICES).toEqual({
      design: { min: 500, max: 1_200 },
      ads: { min: 300, max: 1_500 },
      social: { min: 300, max: 800 },
      content: { min: 250, max: 600 },
      seo: { min: 400, max: 1_000 },
    });

    const design = estimate({ type: "design", size: "medium", budget: "under_200" });
    expect([design.minPrice, design.maxPrice, design.midPrice]).toEqual([500, 1_200, 850]);
    expect(estimate({ type: "design", size: "large" }).minPrice).toBe(750);
    expect(estimate({ type: "design", size: "small" }).minPrice).toBe(400);

    expect(classifyBudget(200)).toBe("weak");
    expect(classifyBudget(500)).toBe("medium");
    expect([BUDGET_BANDS.under_200.max, adDaysForBudget(200)]).toEqual([200, 16]);
    expect(formatCount(37_000, "ar")).toBe("37,000");
  });

  it("shows the ads pricing message with budget, active days and the contact question", () => {
    const body = serviceRequestEstimate({ type: "ads", size: "medium", budget: "under_200", targeting: "iraq_all" }, "ar", {
      email: "client@example.com",
    });
    expect(body).toBe(
      [
        "ميزانيتك: 200$ 🟡",
        "",
        "💡 تغطي 16 يوم إعلان فعّال",
        "",
        "📊 النتائج المتوقعة:",
        "• الظهور: ~37,000-69,000",
        "• الزيارات: ~370-690",
        "• المهتمون: ~9-17",
        "",
        "كيف تحب يتواصل معك فريق أفق؟",
        "□ 📱 واتساب",
        "□ 📧 إيميل: client@example.com",
        "□ 💬 إشعار في الموقع",
      ].join("\n"),
    );

    const summary = serviceRequestSummary({ type: "ads", size: "medium", budget: "under_200", targeting: "iraq_all" }, "ar");
    expect(summary).toContain("- الخدمة: إعلانات");
    expect(summary).toContain("- الحجم: متوسط");
    expect(summary).toContain("- الميزانية: 200$");
    expect(summary).toContain("- المنطقة المستهدفة: 🇮🇶 العراق كله");
  });

  it("shows no impressions for non-ad services and never invents a price for Other", () => {
    const design = estimate({ type: "design", budget: "200_500" });
    expect(design.resultsKind).toBe("none");
    expect([design.expectedReach, design.expectedVisits, design.expectedLeads]).toEqual([null, null, null]);
    expect(design.estimatedAdDays).toBeNull();

    const designBody = serviceRequestEstimate({ type: "design", size: "medium", budget: "under_200", targeting: "baghdad" }, "ar", {
      email: "client@example.com",
    });
    expect(designBody).toContain("السعر التقديري: ~500-1,200$");
    // Above $200 the request is planned across several platforms, so the quote
    // carries the platform multiplier.
    expect(serviceRequestEstimate({ type: "design", size: "medium", budget: "200_500" }, "ar")).toContain(
      "السعر التقديري: ~650-1,560$",
    );
    expect(designBody).not.toMatch(/الظهور|الزيارات|المهتمون|📊/);
    expect(designBody).toContain("□ 📧 إيميل: client@example.com");

    const other = estimate({ type: "other", budget: "under_200" });
    expect([other.minPrice, other.maxPrice, other.midPrice]).toEqual([null, null, null]);
    const otherBody = serviceRequestEstimate({ type: "other" }, "ar");
    expect(otherBody).toContain("ما عندنا نطاق سعر معتمد لهذا النوع");
    expect(otherBody).not.toMatch(/\$\d/);
  });
});
