import { describe, expect, it } from "vitest";

import {
  budgetBandForAmount,
  budgetDetailFromParsed,
  budgetFromAmounts,
  formatBudgetRange,
  mentionsNumber,
  parseBudgetRangeText,
  parseBudgetText,
} from "../src/lib/agents/budget-parser";

/**
 * Layer 1 of the budget reader: deterministic patterns. A budget typed in the
 * chat — as the answer to the budget question or as a change of mind later —
 * must come out as one canonical shape: `200-500` for a range (lower bound
 * first, whatever order the client used) and `350` for a single value.
 */

const text = (message: string, bareNumbers = false) => parseBudgetText(message, { bareNumbers })?.text ?? null;

describe("budget patterns — ranges", () => {
  it.each([
    ["طيب من 200 إلى 500", "200-500"],
    ["من 200 الى 500", "200-500"],
    ["من 500 الى 200", "200-500"],
    ["من 200 ل 500", "200-500"],
    ["200-500$", "200-500"],
    ["$200-500", "200-500"],
    ["200 - 500 دولار", "200-500"],
    ["200 – 500", "200-500"],
    ["200 إلى 500", "200-500"],
    ["200 to 500", "200-500"],
    ["بين 300 و 700", "300-700"],
    ["ميزانيتي من 200 الى 500", "200-500"],
    ["خلي الميزانية من ٢٠٠ إلى ٥٠٠", "200-500"],
    ["budget 1,000 to 1,500", "1000-1500"],
  ])("«%s» → %s", (message, expected) => {
    const parsed = parseBudgetText(message);
    expect(parsed?.kind).toBe("range");
    expect(parsed?.text).toBe(expected);
    const [min, max] = expected.split("-").map(Number);
    expect(parsed?.min).toBe(min);
    expect(parsed?.max).toBe(max);
  });

  it("never produces the reversed «500 من 200» shape", () => {
    for (const message of ["من 500 إلى 200", "500-200", "500 الى 200$"]) {
      const parsed = parseBudgetText(message)!;
      expect(parsed.text).toBe("200-500");
      expect(parsed.text).not.toContain("من");
      expect(parsed.min).toBeLessThanOrEqual(parsed.max);
    }
    expect(formatBudgetRange({ min: 500, max: 200 })).toBe("200-500");
    expect(formatBudgetRange({ min: 350, max: 350 })).toBe("350");
    expect(budgetFromAmounts(500, 200, "USD")).toMatchObject({ min: 200, max: 500, text: "200-500", kind: "range", currency: "USD" });
    expect(budgetFromAmounts(350, null, null)).toMatchObject({ min: 350, max: 350, text: "350", kind: "single" });
  });
});

describe("budget patterns — single values", () => {
  it.each([
    ["ميزانيتي 350", "350"],
    ["ميزانيتي 350 دولار", "350"],
    ["$300", "300"],
    ["300$", "300"],
    ["300 دولار", "300"],
    ["خلي الميزانية 1000", "1000"],
    ["الميزانية تقريباً 1,000$", "1000"],
    ["ميزانيتي ٣٥٠", "350"],
    ["budget 800", "800"],
    ["my budget is $450", "450"],
  ])("«%s» → %s", (message, expected) => {
    const parsed = parseBudgetText(message);
    expect(parsed?.kind).toBe("single");
    expect(parsed?.text).toBe(expected);
    expect(parsed?.min).toBe(Number(expected));
    expect(parsed?.max).toBe(Number(expected));
  });

  it("reads a bare number only while the budget question is open", () => {
    expect(text("300", true)).toBe("300");
    expect(text("1.5k", true)).toBe("1500");
    expect(text("300")).toBeNull();
    expect(text("1.5k")).toBeNull();
  });
});

describe("budget patterns — not a budget", () => {
  it.each([
    ["عندي 15 منشور", false],
    ["07707048629", true],
    ["0770-704-8629", true],
    ["+964 770 704 8629", true],
    ["بغداد فقط", false],
    ["تمام", true],
    ["إعلانات", true],
    ["نعم أكد", true],
    ["تاريخ 2026-10-13", false],
    ["", true],
  ])("«%s» → null", (message, bareNumbers) => {
    expect(parseBudgetText(message, { bareNumbers })).toBeNull();
  });

  it("rejects amounts that cannot be a marketing budget", () => {
    expect(text("ميزانيتي 999999999")).toBeNull();
    expect(text("ميزانيتي 0")).toBeNull();
  });
});

describe("budget details for the request", () => {
  it("maps a typed budget to the published band by its upper bound", () => {
    expect(budgetBandForAmount(150)).toBe("under_200");
    expect(budgetBandForAmount(200)).toBe("under_200");
    expect(budgetBandForAmount(500)).toBe("200_500");
    expect(budgetBandForAmount(1200)).toBe("500_1500");
    expect(budgetBandForAmount(2500)).toBe("over_1500");
    expect(budgetBandForAmount(9000)).toBe("over_1500");
  });

  it("keeps the normalised range and plans on the upper bound", () => {
    expect(budgetDetailFromParsed(parseBudgetText("طيب من 200 إلى 500")!)).toEqual({ range: "200-500", amount: 500 });
    expect(budgetDetailFromParsed(parseBudgetText("ميزانيتي 350")!)).toEqual({ range: "350", amount: 350 });
    expect(parseBudgetRangeText("200-500")).toEqual({ min: 200, max: 500 });
    expect(parseBudgetRangeText("350")).toEqual({ min: 350, max: 350 });
    expect(parseBudgetRangeText("500 من 200")).toBeNull();
    expect(parseBudgetRangeText("")).toBeNull();
  });

  it("tells numeric from non-numeric messages", () => {
    expect(mentionsNumber("طيب من 200 إلى 500")).toBe(true);
    expect(mentionsNumber("ميزانيتي ٣٥٠")).toBe(true);
    expect(mentionsNumber("بغداد فقط")).toBe(false);
  });
});
