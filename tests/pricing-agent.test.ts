/**
 * وكيل التسعير — سياسة الإطلاق «أول 10 زبائن».
 *
 * The pricing agent is deterministic and pure, so every number below is a
 * literal expectation: the founding table, the multipliers, the budget bands
 * (exactly 200 / 500 / 1500, with no translated legacy band), the ad
 * projections, the founding badge and — most importantly — the guarantee that
 * the agency fee and the ad-spend split never leave `_internal`.
 */
import { describe, expect, it } from "vitest";

import {
  ADS_PLANNING_ASSUMPTIONS,
  AGENCY_FEE_PERCENT,
  BUDGET_BANDS,
  CLIENTS_COUNTED_SO_FAR,
  FOUNDING_CLIENTS_TARGET,
  FOUNDING_TIER_PRICES,
  NORMAL_TIER_PRICES,
  TIER_MULTIPLIERS,
  WEAK_BUDGET_SUGGESTIONS,
  FOUNDING_BADGE,
  calculateServiceEstimate,
  classifyBudget,
  describeClientEstimate,
  formatUsd,
  pricingTierFor,
  toClientPricingView,
  type BudgetBand,
  type DeadlineSpeed,
  type PlatformScope,
  type PricingInput,
  type PricingServiceType,
  type ProjectSize,
} from "../src/lib/agents/pricing-agent";

const SERVICE_TYPES: PricingServiceType[] = ["design", "ads", "social", "content", "seo", "other"];
const SIZES: ProjectSize[] = ["small", "medium", "large"];
const PLATFORMS: PlatformScope[] = ["single", "multiple"];
const DEADLINES: DeadlineSpeed[] = ["urgent", "normal", "flexible"];
const BUDGETS: BudgetBand[] = ["under_200", "200_500", "500_1500", "over_1500"];

function input(overrides: Partial<PricingInput> = {}): PricingInput {
  return {
    type: "design",
    size: "medium",
    platforms: "single",
    deadline: "normal",
    budget: "200_500",
    customerCount: 3,
    ...overrides,
  };
}

describe("pricing tier — أول 10 زبائن", () => {
  it("keeps the founding tier for clients 1 to 9 and switches at the 10th", () => {
    expect(FOUNDING_CLIENTS_TARGET).toBe(10);
    expect(pricingTierFor(0)).toBe("founding");
    expect(pricingTierFor(9)).toBe("founding");
    expect(pricingTierFor(10)).toBe("normal");
    expect(pricingTierFor(250)).toBe("normal");
  });

  it("is still in the launch phase today (the constant that must be bumped when a client signs)", () => {
    expect(CLIENTS_COUNTED_SO_FAR).toBeLessThan(FOUNDING_CLIENTS_TARGET);
  });

  it("uses the founding table before the 10th client and the normal table after", () => {
    const founding = calculateServiceEstimate(input({ customerCount: 9 }));
    const normal = calculateServiceEstimate(input({ customerCount: 10 }));

    expect(FOUNDING_TIER_PRICES.design).toEqual({ min: 300, max: 700 });
    expect(NORMAL_TIER_PRICES.design).toEqual({ min: 500, max: 1200 });
    expect([founding.minPrice, founding.maxPrice, founding.midPrice]).toEqual([300, 700, 500]);
    expect([normal.minPrice, normal.maxPrice, normal.midPrice]).toEqual([500, 1200, 850]);
    expect(founding._internal.pricingTier).toBe("founding");
    expect(normal._internal.pricingTier).toBe("normal");
  });

  it("quotes every service type with its own table on both tiers", () => {
    for (const type of SERVICE_TYPES) {
      for (const customerCount of [0, 10]) {
        const result = calculateServiceEstimate(input({ type, customerCount }));
        const table = customerCount < FOUNDING_CLIENTS_TARGET ? FOUNDING_TIER_PRICES : NORMAL_TIER_PRICES;
        expect([table[type].min, table[type].max]).toEqual([result.minPrice, result.maxPrice]);
      }
    }
  });
});

describe("multipliers", () => {
  it("applies size × platforms × deadline of the active tier", () => {
    expect(TIER_MULTIPLIERS.founding.size).toEqual({ small: 0.7, medium: 1, large: 1.3 });
    expect(TIER_MULTIPLIERS.normal.size).toEqual({ small: 0.8, medium: 1, large: 1.5 });

    // design founding, large × multiple × urgent = 1.3 × 1.2 × 1.25 = 1.95
    const founding = calculateServiceEstimate(input({ size: "large", platforms: "multiple", deadline: "urgent" }));
    expect([founding.minPrice, founding.maxPrice, founding.midPrice]).toEqual([585, 1365, 975]);

    // design normal, same answers = 1.5 × 1.3 × 1.4 = 2.73
    const normal = calculateServiceEstimate(input({ size: "large", platforms: "multiple", deadline: "urgent", customerCount: 10 }));
    expect([normal.minPrice, normal.maxPrice, normal.midPrice]).toEqual([1365, 3276, 2321]);
  });

  it("gives no client a price of zero and keeps min ≤ mid ≤ max for every answer combination", () => {
    for (const type of SERVICE_TYPES) {
      for (const size of SIZES) {
        for (const platforms of PLATFORMS) {
          for (const deadline of DEADLINES) {
            for (const budget of BUDGETS) {
              for (const customerCount of [0, 9, 10, 17]) {
                const result = calculateServiceEstimate({ type, size, platforms, deadline, budget, customerCount });
                expect(result.minPrice).toBeGreaterThan(0);
                expect(result.minPrice).toBeLessThanOrEqual(result.midPrice);
                expect(result.midPrice).toBeLessThanOrEqual(result.maxPrice);
              }
            }
          }
        }
      }
    }
  });
});

describe("budget evaluation", () => {
  it("classifies the four bands exactly as the launch policy states", () => {
    const cases: Array<[BudgetBand, string, string, string, string]> = [
      ["under_200", "weak", "ضعيفة", "Tight", "🟡"],
      ["200_500", "medium", "متوسطة", "Moderate", "🟢"],
      ["500_1500", "good", "جيدة", "Good", "🟢🟢"],
      ["over_1500", "excellent", "ممتازة", "Excellent", "🟢🟢🟢"],
    ];
    for (const [budget, quality, labelAr, labelEn, emoji] of cases) {
      const result = calculateServiceEstimate(input({ budget }));
      expect([result.budgetQuality, result.budgetLabel, result.budgetLabelEn, result.budgetEmoji]).toEqual([quality, labelAr, labelEn, emoji]);
      expect(result.budgetBand).toBe(budget);
    }
  });

  it("uses exactly the band values 200 / 500 / 1500, and 3000 for the open-ended band", () => {
    expect(BUDGET_BANDS.under_200.spend).toBe(200);
    expect(BUDGET_BANDS["200_500"].spend).toBe(500);
    expect(BUDGET_BANDS["500_1500"].spend).toBe(1500);
    // «أكثر من 1500$»: 3000 is the planning value — no 99,999 sentinel anywhere.
    expect(BUDGET_BANDS.over_1500.spend).toBe(3000);
    expect(JSON.stringify(BUDGET_BANDS)).not.toContain("99999");

    for (const band of BUDGETS) {
      expect(BUDGET_BANDS[band].quality).toBe(classifyBudget(BUDGET_BANDS[band].spend));
    }
    expect(classifyBudget(200)).toBe("weak");
    expect(classifyBudget(500)).toBe("medium");
    expect(classifyBudget(1500)).toBe("good");
    expect(classifyBudget(3000)).toBe("excellent");
  });

  it("over_1500 never produces a money figure above $10,000 — and no other band does", () => {
    // The whole point of the 3000 cap: a client who says «أكثر من 1500$» gets a
    // plausible plan (ad spend 3000$, a price range in the low thousands), not an
    // invented multi-million projection built from a 99,999 sentinel.
    for (const budget of BUDGETS) {
      for (const type of SERVICE_TYPES) {
        for (const customerCount of [0, 10]) {
          const result = calculateServiceEstimate({ type, size: "large", platforms: "multiple", deadline: "urgent", budget, customerCount });
          for (const money of [result.minPrice, result.midPrice, result.maxPrice, result._internal.agencyFee, result._internal.adSpend]) {
            expect(money).toBeLessThan(10_000);
          }
        }
      }
    }

    // The projected ad spend is the band value itself, and every dollar figure
    // the client is shown for that band stays under $10,000.
    const ads = calculateServiceEstimate(input({ type: "ads", budget: "over_1500" }));
    expect(BUDGET_BANDS.over_1500.spend).toBe(3000);
    expect(ads.expectedLeads[1]).toBeLessThan(10_000);
    for (const locale of ["ar", "en"] as const) {
      const money = [...describeClientEstimate(ads, locale).matchAll(/([\d,]+)\$/g)].map((match) => Number(match[1]!.replace(/,/g, "")));
      expect(money.length).toBeGreaterThan(0);
      for (const amount of money) expect(amount).toBeLessThan(10_000);
    }

    // Counts are not money: impressions and visits are legitimately larger than
    // $10,000 would be (a 3000$ spend buys ~1M impressions at CPM 3$).
    expect(ads.expectedReach).toEqual([700_000, 1_300_000]);
    expect(ads.expectedVisits).toEqual([14_000, 26_000]);
    expect(ads.expectedLeads).toEqual([420, 780]);
  });
});

describe("expected results", () => {
  it("projects ads from the planning assumptions: CPM, then click rate, then conversion", () => {
    expect(ADS_PLANNING_ASSUMPTIONS).toMatchObject({ cpm: 3, clickRate: 0.02, conversionRate: 0.03, spreadLow: 0.7, spreadHigh: 1.3 });

    // Band value 500$ → 166,666 impressions → 3,333 visits → 100 leads, each as a ±30% range.
    const ads = calculateServiceEstimate(input({ type: "ads", budget: "200_500" }));
    expect(ads.resultsKind).toBe("numbers");
    expect(ads.expectedReach).toEqual([116_700, 216_700]);
    expect(ads.expectedVisits).toEqual([2_330, 4_330]);
    expect(ads.expectedLeads).toEqual([70, 130]);

    // The weakest band still produces a usable range.
    const weak = calculateServiceEstimate(input({ type: "ads", budget: "under_200" }));
    expect(weak.expectedReach).toEqual([46_700, 86_700]);
    expect(weak.expectedVisits).toEqual([930, 1_730]);
    expect(weak.expectedLeads).toEqual([28, 52]);
  });

  it("never invents performance numbers for a service that is not ads: it describes the outcome instead", () => {
    for (const type of SERVICE_TYPES.filter((entry) => entry !== "ads")) {
      const result = calculateServiceEstimate(input({ type }));
      expect(result.resultsKind).toBe("qualitative");
      expect([result.expectedReach, result.expectedVisits, result.expectedLeads]).toEqual([
        [0, 0],
        [0, 0],
        [0, 0],
      ]);
      expect(result.qualitativeAr).toBeTruthy();
      expect(result.qualitativeEn).toBeTruthy();
    }

    const design = calculateServiceEstimate(input({ type: "design" }));
    expect(design.qualitativeAr).toContain("تصاميم بهوية واحدة");
    expect(design.qualitativeEn).toContain("Designs under one identity");

    const ads = calculateServiceEstimate(input({ type: "ads" }));
    expect(ads.qualitativeAr).toBeNull();
    expect(ads.qualitativeEn).toBeNull();
  });
});

describe("weak budget suggestions", () => {
  it("offers exactly the launch suggestions only when the budget is weak", () => {
    const weak = calculateServiceEstimate(input({ budget: "under_200" }));
    expect(weak.suggestions).toEqual([...WEAK_BUDGET_SUGGESTIONS.ar]);
    expect(weak.suggestionsEn).toEqual([...WEAK_BUDGET_SUGGESTIONS.en]);
    expect(weak.suggestions).toContain("نبدأ بمنصة وحدة (Instagram مثلاً) ونوسع لاحقاً");
    expect(weak.suggestions).toHaveLength(3);

    for (const budget of BUDGETS.filter((entry) => entry !== "under_200")) {
      const result = calculateServiceEstimate(input({ budget }));
      expect(result.suggestions).toEqual([]);
      expect(result.suggestionsEn).toEqual([]);
    }
  });
});

describe("internal split (never client-facing)", () => {
  it("splits the agreed price into the agency fee and the ad spend, founding 20% / normal 25%", () => {
    expect(AGENCY_FEE_PERCENT).toEqual({ founding: 0.2, normal: 0.25 });

    const adsFounding = calculateServiceEstimate(input({ type: "ads", customerCount: 9 }));
    expect(adsFounding.midPrice).toBe(500);
    expect(adsFounding._internal.agencyFee).toBe(100);
    expect(adsFounding._internal.adSpend).toBe(400);

    const adsNormal = calculateServiceEstimate(input({ type: "ads", customerCount: 10 }));
    expect(adsNormal.midPrice).toBe(900);
    expect(adsNormal._internal.agencyFee).toBe(225);
    expect(adsNormal._internal.adSpend).toBe(675);
  });

  it("carries no ad spend outside ads, and splits the ads price into fee + spend", () => {
    for (const type of SERVICE_TYPES.filter((entry) => entry !== "ads")) {
      const result = calculateServiceEstimate(input({ type }));
      expect(result._internal.adSpend).toBe(0);
      expect(result._internal.agencyFee).toBe(Math.round(result.midPrice * AGENCY_FEE_PERCENT.founding));
    }

    // For ads the agreed price IS the managed budget: fee + spend must add up to it.
    for (const customerCount of [0, 10]) {
      const ads = calculateServiceEstimate(input({ type: "ads", customerCount }));
      expect(ads._internal.agencyFee + ads._internal.adSpend).toBe(ads.midPrice);
      expect(ads._internal.adSpend).toBeGreaterThan(0);
    }
  });

  it("hands the UI a view built field by field, with no path to the fee or the spend", () => {
    const result = calculateServiceEstimate(input({ type: "ads", budget: "500_1500" }));
    const view = toClientPricingView(result, "ar");

    expect(Object.keys(view).sort()).toEqual(
      ["budgetEmoji", "budgetLabel", "budgetQuality", "foundingClient", "maxPrice", "midPrice", "minPrice", "results", "service", "suggestions"].sort(),
    );
    // The fee and the split are impossible to reach by name — the founding flag
    // is the only internal fact that travels, and it is a boolean, not an amount.
    expect(JSON.stringify(view)).not.toMatch(/agencyFee|adSpend|_internal|"normal"|%|\b25\b/);
    expect(typeof view.foundingClient).toBe("boolean");
    expect([view.minPrice, view.midPrice, view.maxPrice]).toEqual([result.minPrice, result.midPrice, result.maxPrice]);
  });

  it("localises the budget label, the suggestions and the qualitative text", () => {
    const weak = calculateServiceEstimate(input({ budget: "under_200" }));
    expect(toClientPricingView(weak, "ar").budgetLabel).toBe("ضعيفة");
    expect(toClientPricingView(weak, "en").budgetLabel).toBe("Tight");
    expect(toClientPricingView(weak, "en").suggestions).toEqual([...WEAK_BUDGET_SUGGESTIONS.en]);

    const design = calculateServiceEstimate(input({ type: "design" }));
    expect(toClientPricingView(design, "ar").results).toEqual({ kind: "qualitative", text: design.qualitativeAr });
    expect(toClientPricingView(design, "en").results).toEqual({ kind: "qualitative", text: design.qualitativeEn });

    const ads = calculateServiceEstimate(input({ type: "ads" }));
    expect(toClientPricingView(ads, "ar").results).toEqual({
      kind: "numbers",
      reach: ads.expectedReach,
      visits: ads.expectedVisits,
      leads: ads.expectedLeads,
    });
  });
});

describe("founding-client badge — أول 10 زبائن", () => {
  it("shows the badge while the client is among the first 10, and removes it afterwards", () => {
    expect(FOUNDING_BADGE.ar).toBe("🎉 مبروك! أنت من أول 10 زبائن لأفق — أسعار خاصة + مراجعات إضافية مجاناً");

    const founding = calculateServiceEstimate(input({ type: "ads", budget: "500_1500", customerCount: 9 }));
    const normal = calculateServiceEstimate(input({ type: "ads", budget: "500_1500", customerCount: 10 }));

    expect(toClientPricingView(founding, "ar").foundingClient).toBe(true);
    expect(toClientPricingView(founding, "en").foundingClient).toBe(true);
    expect(toClientPricingView(normal, "ar").foundingClient).toBe(false);

    const text = describeClientEstimate(founding, "ar");
    expect(text).toContain(FOUNDING_BADGE.ar);
    // It sits right under the budget read, before the results.
    expect(text.indexOf(FOUNDING_BADGE.ar)).toBeGreaterThan(text.indexOf("📊 تقييم الميزانية"));
    expect(text.indexOf(FOUNDING_BADGE.ar)).toBeLessThan(text.indexOf("📈 النتائج المتوقعة"));
    // The badge promises free extra revisions; it must never name a percentage or a fee.
    expect(FOUNDING_BADGE.ar).not.toMatch(/أتعاب|عمولة|نصيب|%|توزيع/);

    expect(describeClientEstimate(normal, "ar")).not.toContain("مبروك");
    expect(describeClientEstimate(founding, "en")).toContain(FOUNDING_BADGE.en);
    expect(describeClientEstimate(normal, "en")).not.toContain("Congratulations");
  });
});

describe("client-facing wording", () => {
  it("prices an ads request with the planning ranges and, on a weak budget, the launch suggestions", () => {
    const text = describeClientEstimate(
      calculateServiceEstimate({ type: "ads", size: "small", platforms: "multiple", deadline: "normal", budget: "under_200", customerCount: 0 }),
      "ar",
    );

    expect(text).toContain("💰 السعر التقديري: 168$ – 672$");
    expect(text).toContain("🎯 الأنسب لمشروعك: 420$");
    expect(text).toContain("📊 تقييم الميزانية: 🟡 ضعيفة");
    expect(text).toContain("• الظهور: 46,700 – 86,700");
    expect(text).toContain("• الزيارات: 930 – 1,730");
    expect(text).toContain("• العملاء المحتملون: 28 – 52");
    expect(text).toContain("• نبدأ بخدمة أصغر (تصميم شعار فقط مثلاً)");

    // 420$ mid price → 84$ agency fee and 336$ ad spend: neither is ever written,
    // and the split is never named.
    expect(text).not.toContain("84$");
    expect(text).not.toContain("336$");
    expect(text).not.toMatch(/أتعاب|عمولة|توزيع الميزانية|نصيب|agency fee|ad spend|20%|25%/);
  });

  it("never prints an impression, a visit or a lead for a service that is not ads — in either language", () => {
    for (const type of SERVICE_TYPES.filter((entry) => entry !== "ads")) {
      for (const locale of ["ar", "en"] as const) {
        const text = describeClientEstimate(calculateServiceEstimate(input({ type })), locale);
        expect(text).not.toMatch(/الظهور|الزيارات|العملاء المحتملون|Impressions|Visits|Leads/);
      }
    }
  });
});

describe("client-facing money", () => {
  it("formats whole dollars with Latin digits in both languages", () => {
    expect(formatUsd(375, "ar")).toBe("375$");
    expect(formatUsd(1200, "ar")).toBe("1,200$");
    expect(formatUsd(350_000, "en")).toBe("350,000$");
  });
});
