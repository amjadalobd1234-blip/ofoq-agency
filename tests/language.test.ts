import { describe, expect, it } from "vitest";

import {
  detectBudget,
  detectLanguage,
  detectPlatforms,
  detectPostCount,
  detectServiceHints,
  detectTimelineDays,
  normaliseDigits,
  resolveLocale,
} from "../src/lib/ai/language";
import { classifyIntent, translateStatus } from "../src/lib/agents/specialists/support.agent";

describe("language detection", () => {
  it("detects Arabic and English", () => {
    expect(detectLanguage("أريد إدارة حسابات التواصل")).toBe("ar");
    expect(detectLanguage("I need social media management")).toBe("en");
    expect(detectLanguage("12345")).toBe("unknown");
    expect(detectLanguage("")).toBe("unknown");
  });

  it("falls back to the customer locale when the text has no letters", () => {
    expect(resolveLocale("12345", "ar")).toBe("ar");
    expect(resolveLocale("12345", "en")).toBe("en");
    expect(resolveLocale("مرحبا", "en")).toBe("ar");
  });

  it("normalises Arabic-Indic digits", () => {
    expect(normaliseDigits("١٢٣")).toBe("123");
    expect(normaliseDigits("۱۲۳")).toBe("123");
  });
});

describe("requirement extraction from free text", () => {
  it("maps Arabic phrases to service slugs", () => {
    const hints = detectServiceHints("أريد إدارة حسابات التواصل الاجتماعي وكتابة منشورات");
    expect(hints).toContain("social_media_management");
    expect(hints).toContain("content_design");
  });

  it("maps English phrases to service slugs", () => {
    const hints = detectServiceHints("We need a website and SEO");
    expect(hints).toContain("web_development");
    expect(hints).toContain("seo");
  });

  it("detects budgets with currency", () => {
    const usd = detectBudget("ميزانيتي حوالي 500 دولار");
    expect(usd?.max).toBe(500);
    expect(usd?.currency).toBe("USD");

    const range = detectBudget("between 1000 and 2000 usd");
    expect(range?.min).toBe(1000);
    expect(range?.max).toBe(2000);
  });

  it("detects platforms in both languages", () => {
    expect(detectPlatforms("إنستغرام وفيسبوك")).toEqual(expect.arrayContaining(["instagram", "facebook"]));
    expect(detectPlatforms("instagram, tiktok")).toEqual(expect.arrayContaining(["instagram", "tiktok"]));
  });

  it("detects timelines and volumes", () => {
    expect(detectTimelineDays("خلال أسبوعين")).toBe(14);
    expect(detectTimelineDays("in 10 days")).toBe(10);
    expect(detectTimelineDays("عاجل")).toBe(7);
    expect(detectPostCount("أحتاج 20 منشورًا")).toBe(20);
  });
});

describe("support intent classification", () => {
  it("recognises the common client intents", () => {
    expect(classifyIntent("حالة مشاريعي")).toBe("PROJECT_STATUS");
    expect(classifyIntent("my project status")).toBe("PROJECT_STATUS");
    expect(classifyIntent("كم سعر إدارة الإعلانات؟")).toBe("PRICING_QUESTION");
    expect(classifyIntent("أريد فاتورة")).toBe("BILLING_QUESTION");
    expect(classifyIntent("تفاصيل أكثر")).toBe("DEEP_REPORT_REQUEST");
    expect(classifyIntent("أريد التحدث مع موظف")).toBe("HUMAN_REQUEST");
    expect(classifyIntent("أنا غير راضي عن الخدمة")).toBe("COMPLAINT");
  });

  it("translates statuses into plain Arabic", () => {
    expect(translateStatus("IN_PROGRESS", "ar")).toBe("قيد التنفيذ");
    expect(translateStatus("AWAITING_PAYMENT", "en")).toBe("awaiting payment");
    expect(translateStatus("SOMETHING_NEW", "ar")).toBe("SOMETHING_NEW");
  });
});
