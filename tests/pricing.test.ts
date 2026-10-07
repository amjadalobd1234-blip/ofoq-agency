import { describe, expect, it } from "vitest";

import {
  DEFAULT_PRICING_POLICY,
  buildQuote,
  inferComplexity,
  mergePolicy,
} from "../src/lib/domain/pricing";
import type { ServiceRow } from "../src/lib/domain/types";

function makeService(overrides: Partial<ServiceRow> = {}): ServiceRow {
  return {
    id: overrides.id ?? "svc-1",
    slug: overrides.slug ?? "content-design",
    name_ar: "كتابة وتصميم المنشورات",
    name_en: "Post writing and design",
    short_ar: null,
    short_en: null,
    description_ar: null,
    description_en: null,
    category: "content",
    billing_type: overrides.billing_type ?? "SUBSCRIPTION",
    unit: overrides.unit ?? "POST",
    base_price_minor: overrides.base_price_minor ?? 2_000,
    min_price_minor: overrides.min_price_minor ?? 1_000,
    currency: "USD",
    delivery_days: 7,
    revisions_included: 2,
    complexity_factor: 1,
    requires_approval_above_minor: null,
    is_active: 1,
    sort_order: 0,
    pricing_config: null,
    cancellation_policy: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

describe("pricing engine", () => {
  it("prices a single simple service at its base price", () => {
    const quote = buildQuote({ lines: [{ service: makeService(), quantity: 1, complexity: "STANDARD" }] });
    expect(quote.totalMinor).toBe(2_000);
    expect(quote.currency).toBe("USD");
    expect(quote.requiresApproval).toBe(false);
    expect(quote.reasons).toContain("content-design:base");
  });

  it("applies a volume discount for larger quantities", () => {
    const quote = buildQuote({ lines: [{ service: makeService(), quantity: 12, complexity: "STANDARD" }] });
    // 12 posts → 0.9 volume factor → 1800 per post × 12
    expect(quote.lines[0]!.unitPriceMinor).toBe(1_800);
    expect(quote.totalMinor).toBe(21_600);
    expect(quote.reasons.some((reason) => reason.includes("volume"))).toBe(true);
  });

  it("increases the price for multiple platforms", () => {
    const single = buildQuote({
      lines: [{ service: makeService({ unit: "PROJECT", billing_type: "ONE_TIME" }), quantity: 1 }],
      platforms: ["instagram"],
    });
    const many = buildQuote({
      lines: [{ service: makeService({ unit: "PROJECT", billing_type: "ONE_TIME" }), quantity: 1 }],
      platforms: ["instagram", "facebook", "tiktok"],
    });
    expect(many.totalMinor).toBeGreaterThan(single.totalMinor);
    expect(many.lines[0]!.factors.some((factor) => factor.key === "platforms")).toBe(true);
  });

  it("applies urgency pricing for compressed timelines", () => {
    const normal = buildQuote({ lines: [{ service: makeService(), quantity: 1, deliveryDays: 30 }] });
    const urgent = buildQuote({ lines: [{ service: makeService(), quantity: 1, deliveryDays: 2 }] });
    expect(urgent.totalMinor).toBeGreaterThan(normal.totalMinor);
    expect(urgent.lines[0]!.factors.some((factor) => factor.key === "urgency" && factor.factor === 1.5)).toBe(true);
  });

  it("never prices below the configured minimum", () => {
    const quote = buildQuote({
      lines: [
        {
          service: makeService({ base_price_minor: 100, min_price_minor: 5_000, unit: "PROJECT", billing_type: "ONE_TIME" }),
          quantity: 1,
        },
      ],
    });
    expect(quote.totalMinor).toBe(5_000);
    expect(quote.escalations.some((entry) => entry.code === "below_floor")).toBe(true);
    expect(quote.requiresApproval).toBe(true);
  });

  it("escalates large projects and thin margins instead of approving silently", () => {
    const quote = buildQuote({
      lines: [
        {
          service: makeService({
            base_price_minor: 900_000,
            min_price_minor: 0,
            unit: "PROJECT",
            billing_type: "ONE_TIME",
          }),
          quantity: 1,
        },
      ],
    });
    expect(quote.escalations.some((entry) => entry.code === "large_project")).toBe(true);
    expect(quote.requiresApproval).toBe(true);
    expect(quote.riskLevel).toBe("HIGH");
  });

  it("escalates discounts above the automatic limit", () => {
    const quote = buildQuote({
      lines: [{ service: makeService({ unit: "PROJECT", billing_type: "ONE_TIME" }), quantity: 1 }],
      requestedDiscountPercent: 30,
      policy: { maxAutoDiscountPercent: 10 },
    });
    expect(quote.escalations.some((entry) => entry.code === "large_discount")).toBe(true);
    expect(quote.discountMinor).toBeGreaterThan(0);
  });

  it("records the reason for every applied factor", () => {
    const quote = buildQuote({
      lines: [{ service: makeService(), quantity: 20, complexity: "ADVANCED", deliveryDays: 5 }],
      platforms: ["instagram", "facebook"],
      countries: ["US"],
      requestedDiscountPercent: 5,
    });
    expect(quote.reasons.length).toBeGreaterThan(3);
    expect(quote.reasons.join(" ")).toMatch(/volume|complexity|urgency|platforms|market/);
    expect(quote.breakdown.length).toBeGreaterThan(0);
    // Internal cost/margin live on the quote (staff-only) — never in client text.
    expect(quote.internalCostMinor).toBeGreaterThan(0);
  });

  it("flags quotes above the client's stated budget", () => {
    const quote = buildQuote({
      lines: [{ service: makeService({ unit: "PROJECT", billing_type: "ONE_TIME" }), quantity: 1 }],
      budgetMaxMinor: 500,
    });
    expect(quote.escalations.some((entry) => entry.code === "above_budget")).toBe(true);
  });

  it("keeps a neutral market factor by default", () => {
    const policy = mergePolicy();
    expect(policy.marketFactors.DEFAULT).toBe(1);
    const quote = buildQuote({
      lines: [{ service: makeService(), quantity: 1, complexity: "STANDARD" }],
      countries: ["IQ"],
    });
    // IQ is neutral in the default policy.
    expect(quote.totalMinor).toBe(2_000);
  });

  it("infers complexity from objective signals", () => {
    expect(inferComplexity({ platforms: ["instagram"] })).toBe("SIMPLE");
    expect(inferComplexity({ platforms: ["instagram", "facebook", "tiktok", "x"], website: true })).toBe("ADVANCED");
    expect(
      inferComplexity({
        platforms: ["instagram", "facebook", "tiktok", "x"],
        website: true,
        postCount: 40,
        languages: ["ar", "en"],
        countries: ["IQ", "AE"],
      }),
    ).toBe("ENTERPRISE");
  });

  it("documents its policy defaults (no invented market data)", () => {
    expect(DEFAULT_PRICING_POLICY.internalCostRatio).toBeGreaterThan(0);
    expect(DEFAULT_PRICING_POLICY.minimumMarginPercent).toBeGreaterThan(0);
    expect(DEFAULT_PRICING_POLICY.urgencyBands.length).toBeGreaterThan(0);
  });
});
