import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  ADS_PLANNING_ASSUMPTIONS,
  BUDGET_BANDS,
  PRICE_MULTIPLIERS,
  SERVICES,
  TARGETING_FACTORS,
  calculateServiceEstimate,
  classifyBudget,
  type PricingInput,
} from "../src/lib/agents/pricing-agent";

const BASE_INPUT: PricingInput = {
  type: "design",
  size: "medium",
  platforms: "single",
  deadline: "normal",
  budget: "under_200",
  targeting: "iraq_all",
};

function estimate(overrides: Partial<PricingInput> = {}) {
  return calculateServiceEstimate({ ...BASE_INPUT, ...overrides });
}

describe("official prices and scope multipliers", () => {
  it("prices medium design at the official $500–$1,200 range", () => {
    const result = estimate({ type: "design" });
    expect([result.minPrice, result.maxPrice, result.midPrice]).toEqual([500, 1_200, 850]);
  });

  it("raises the ads quote for multiple platforms", () => {
    const single = estimate({ type: "ads", platforms: "single" });
    const multiple = estimate({ type: "ads", platforms: "multiple" });
    expect([single.minPrice, single.maxPrice]).toEqual([300, 1_500]);
    expect(multiple.minPrice).toBeGreaterThan(single.minPrice!);
    expect(multiple.maxPrice).toBeGreaterThan(single.maxPrice!);
  });

  it("raises the quote for urgent delivery", () => {
    const normal = estimate({ type: "design", deadline: "normal" });
    const urgent = estimate({ type: "design", deadline: "urgent" });
    expect([urgent.minPrice, urgent.maxPrice]).toEqual([700, 1_680]);
    expect(urgent.minPrice).toBeGreaterThan(normal.minPrice!);
  });

  it("raises the quote for a large project", () => {
    const medium = estimate({ type: "design", size: "medium" });
    const large = estimate({ type: "design", size: "large" });
    expect([large.minPrice, large.maxPrice]).toEqual([750, 1_800]);
    expect(large.maxPrice).toBeGreaterThan(medium.maxPrice!);
  });

  it("keeps only the requested official price ranges", () => {
    expect(SERVICES).toEqual({
      design: { min: 500, max: 1_200 },
      ads: { min: 300, max: 1_500 },
      social: { min: 300, max: 800 },
      content: { min: 250, max: 600 },
      seo: { min: 400, max: 1_000 },
    });
    expect(PRICE_MULTIPLIERS).toEqual({
      size: { small: 0.8, medium: 1, large: 1.5 },
      platforms: { single: 1, multiple: 1.3 },
      deadline: { urgent: 1.4, normal: 1, flexible: 0.9 },
    });
  });
});

describe("budget quality", () => {
  it("classifies a $200 budget as weak", () => {
    const result = estimate({ budget: "under_200" });
    expect([result.budgetAmount, result.budgetQuality, result.budgetLabel, result.budgetEmoji]).toEqual([200, "weak", "ضعيفة", "🟡"]);
  });

  it("classifies a $500 budget as medium", () => {
    const result = estimate({ budget: "200_500" });
    expect([result.budgetAmount, result.budgetQuality, result.budgetLabel, result.budgetEmoji]).toEqual([500, "medium", "متوسطة", "🟢"]);
  });

  it("classifies a $1,500 budget as good", () => {
    const result = estimate({ budget: "500_1500" });
    expect([result.budgetAmount, result.budgetQuality, result.budgetLabel, result.budgetEmoji]).toEqual([1_500, "good", "جيدة", "🟢🟢"]);
  });

  it("classifies the open-ended band with its $3,000 planning cap as excellent", () => {
    const result = estimate({ budget: "over_1500" });
    expect([BUDGET_BANDS.over_1500.max, result.budgetQuality, result.budgetLabel, result.budgetEmoji]).toEqual([3_000, "excellent", "ممتازة", "🟢🟢🟢"]);
    expect([classifyBudget(200), classifyBudget(500), classifyBudget(1_500), classifyBudget(1_501)]).toEqual([
      "weak",
      "medium",
      "good",
      "excellent",
    ]);
  });
});

describe("targeting and conservative ad estimates", () => {
  it("uses Iraq-wide reach at 1.0x", () => {
    expect(TARGETING_FACTORS.iraq_all.reach).toBe(1.0);
  });

  it("uses Basra reach at 0.12x", () => {
    expect(TARGETING_FACTORS.basra.reach).toBe(0.12);
  });

  it("applies the Gulf CPM multiplier of 4x", () => {
    expect(TARGETING_FACTORS.gulf.cpm).toBe(4.0);
  });

  it("returns the specified conservative $200 Iraq-wide ad range", () => {
    const result = estimate({ type: "ads", budget: "under_200", targeting: "iraq_all" });
    expect(ADS_PLANNING_ASSUMPTIONS).toMatchObject({ clickRate: 0.01, conversionRate: 0.025, spreadLow: 0.7, spreadHigh: 1.3 });
    expect(result.expectedReach).toEqual([8_000, 15_000]);
    expect(result.expectedVisits).toEqual([80, 150]);
    expect(result.expectedLeads).toEqual([2, 4]);
  });

  it("estimates more impressions for a $1,000-range budget than for $200", () => {
    const low = estimate({ type: "ads", budget: "under_200" });
    // $1,000 falls within the selected $500–$1,500 budget band.
    const higher = estimate({ type: "ads", budget: "500_1500" });
    expect(higher.expectedReach![0]).toBeGreaterThan(low.expectedReach![0]);
    expect(higher.expectedReach![1]).toBeGreaterThan(low.expectedReach![1]);
  });

  it("does not produce performance numbers for non-ad services", () => {
    const design = estimate({ type: "design" });
    expect(design.resultsKind).toBe("none");
    expect([design.expectedReach, design.expectedVisits, design.expectedLeads]).toEqual([null, null, null]);
  });

  it("does not invent a price for the unlisted Other service", () => {
    const other = estimate({ type: "other" });
    expect([other.minPrice, other.maxPrice, other.midPrice]).toEqual([null, null, null]);
    expect(other.resultsKind).toBe("none");
  });

  it("keeps $200 Iraq-wide impression estimates below 100,000", () => {
    const result = estimate({ type: "ads", budget: "under_200", targeting: "iraq_all" });
    expect(result.expectedReach![1]).toBeLessThanOrEqual(100_000);
  });
});

describe("removed launch-tier policy", () => {
  it("has no launch badge, client count, or tier switching in the pricing/chat source", () => {
    const source = [
      readFileSync("src/lib/agents/pricing-agent.ts", "utf8"),
      readFileSync("src/components/assistant-chat.tsx", "utf8"),
    ].join("\n");
    expect(source).not.toMatch(/founding|CLIENTS_COUNTED_SO_FAR|customerCount|pricingTier|NORMAL_TIER|TIER_MULTIPLIERS/i);
  });
});
