import { formatMoney } from "@/lib/core/money";
import { buildQuote, inferComplexity, type QuoteResult } from "@/lib/domain/pricing";
import type { CustomerRow, Locale, ServiceRow } from "@/lib/domain/types";
import { listServices } from "@/lib/repositories/catalog.repo";

import { runAgent } from "../runtime";
import type { RequirementProfile } from "./needs.agent";

/**
 * Pricing agent.
 *
 * Chooses the services that match the client's stated need, prices them through
 * the deterministic pricing engine, and decides whether the quote can be
 * confirmed automatically or must be escalated to the owner/partner.
 *
 * The agent NEVER decides refunds and never prices outside the configured
 * policy; every factor behind the number is stored with the offer row.
 */
export interface PricingOutcome {
  quote: QuoteResult;
  services: ServiceRow[];
  unknownServices: string[];
  /** True when the quote is inside the safe range and may be sent as-is. */
  autoApproved: boolean;
  escalations: { code: string; messageAr: string; messageEn: string }[];
  /** Plain-language explanation for the client (no internal costs). */
  clientExplanationAr: string;
  clientExplanationEn: string;
}

export interface PricingOptions {
  /** Extra months for subscription services. */
  months?: number | null;
  requestedDiscountPercent?: number;
  policyOverrides?: Parameters<typeof buildQuote>[0]["policy"];
}

export async function priceRequirements(
  customer: CustomerRow,
  profile: RequirementProfile,
  options: PricingOptions = {},
): Promise<PricingOutcome> {
  const allServices = await listServices({ activeOnly: true });
  const wantedSlugs = profile.services.length > 0 ? profile.services : ["consulting"];
  const matched: ServiceRow[] = [];
  const unknownServices: string[] = [];

  for (const slug of wantedSlugs) {
    const service = allServices.find((row) => row.slug === slug);
    if (service) matched.push(service);
    else unknownServices.push(slug);
  }

  if (matched.length === 0) {
    // Nothing matched the catalogue: fall back to consulting and escalate.
    const fallback = allServices.find((row) => row.slug === "consulting") ?? allServices[0];
    if (fallback) matched.push(fallback);
  }

  const complexity = inferComplexity({
    platforms: profile.platforms,
    postCount: profile.volume,
    website: matched.some((service) => service.slug === "web-development"),
    countries: [profile.country ?? "DEFAULT"],
    languages: [customer.locale],
  });

  const months =
    options.months ??
    (matched.some((service) => service.billing_type === "SUBSCRIPTION")
      ? Math.max(1, Math.ceil((profile.timelineDays ?? 30) / 30))
      : null);

  const quote = buildQuote({
    lines: matched.map((service) => ({
      service,
      quantity:
        service.unit === "MONTH"
          ? (months ?? 1)
          : service.unit === "POST" || service.unit === "DESIGN"
            ? (profile.volume ?? 1)
            : 1,
      months,
      complexity,
      deliveryDays: profile.timelineDays ?? service.delivery_days,
    })),
    platforms: profile.platforms,
    countries: [profile.country ?? customer.country ?? "DEFAULT"],
    languages: [customer.locale],
    budgetMaxMinor: profile.budgetMaxMinor,
    requestedDiscountPercent: options.requestedDiscountPercent,
    currency: profile.budgetCurrency ?? customer.currency,
    policy: options.policyOverrides,
  });

  const escalations = [...quote.escalations];
  for (const slug of unknownServices) {
    escalations.push({
      code: "unknown_service",
      messageAr: `الخدمة «${slug}» غير موجودة في قائمة خدمات الوكالة وتحتاج مراجعة.`,
      messageEn: `The service "${slug}" is not in the agency catalogue and needs review.`,
    });
  }

  const autoApproved = escalations.length === 0;

  const clientExplanationAr = explainForClient(quote, "ar", profile, matched);
  const clientExplanationEn = explainForClient(quote, "en", profile, matched);

  await runAgent(
    "pricing",
    {
      trigger: "needs.ready",
      locale: customer.locale,
      customerId: customer.id,
      input: { services: matched.map((service) => service.slug), escalations: escalations.map((e) => e.code) },
    },
    async ({ record }) => {
      record({
        action: "quote.created",
        summary: `تم احتساب سعر مبدئي ${formatMoney(quote.totalMinor, quote.currency, "ar")}`,
        reason: quote.reasons.slice(0, 12).join(" | "),
        entityType: "customer",
        entityId: customer.id,
        riskLevel: quote.riskLevel,
        requiresApproval: !autoApproved,
        payload: {
          totalMinor: quote.totalMinor,
          currency: quote.currency,
          marginPct: quote.marginPct,
          escalations: escalations.map((entry) => entry.code),
        },
      });
      if (!autoApproved) {
        record({
          action: "quote.escalated",
          summary: "حالة سعرية غير معتادة تحتاج موافقة المالك أو الشريك",
          reason: escalations.map((entry) => entry.code).join(", "),
          riskLevel: "HIGH",
          requiresApproval: true,
          entityType: "customer",
          entityId: customer.id,
        });
      }
      return {
        data: {
          totalMinor: quote.totalMinor,
          currency: quote.currency,
          autoApproved,
        },
        summary: autoApproved
          ? `تسعير تلقائي: ${formatMoney(quote.totalMinor, quote.currency, "ar")}`
          : `تسعير يحتاج مراجعة: ${formatMoney(quote.totalMinor, quote.currency, "ar")}`,
        riskLevel: quote.riskLevel,
      };
    },
  );

  return {
    quote,
    services: matched,
    unknownServices,
    autoApproved,
    escalations,
    clientExplanationAr,
    clientExplanationEn,
  };
}

/**
 * Client-facing explanation: totals, timeline and what is included.
 * Internal costs and margins are deliberately excluded — those stay in the
 * owner dashboard only.
 */
export function explainForClient(
  quote: QuoteResult,
  locale: Locale,
  profile: RequirementProfile,
  services: ServiceRow[],
): string {
  const lines: string[] = [];
  const isAr = locale === "ar";

  lines.push(
    isAr
      ? `السعر الإجمالي المقترح: ${formatMoney(quote.totalMinor, quote.currency, locale)}`
      : `Suggested total: ${formatMoney(quote.totalMinor, quote.currency, locale)}`,
  );
  if (quote.discountMinor > 0) {
    lines.push(
      isAr
        ? `ويشمل خصمًا بقيمة ${formatMoney(quote.discountMinor, quote.currency, locale)}`
        : `Includes a discount of ${formatMoney(quote.discountMinor, quote.currency, locale)}`,
    );
  }
  lines.push(
    isAr
      ? `مدة التنفيذ المتوقعة: ${quote.deliveryDays} يوم من تاريخ البدء.`
      : `Expected delivery: ${quote.deliveryDays} days from the start date.`,
  );
  lines.push(
    isAr
      ? `عدد جولات التعديل المتضمنة: ${quote.revisionRounds}.`
      : `Included revision rounds: ${quote.revisionRounds}.`,
  );
  for (const line of quote.lines) {
    const label = isAr ? line.nameAr : line.nameEn;
    const unitLabel = describeUnit(line.unit, locale);
    lines.push(
      isAr
        ? `• ${label}: ${line.quantity} ${unitLabel} — ${formatMoney(line.totalMinor, quote.currency, locale)}`
        : `• ${label}: ${line.quantity} ${unitLabel} — ${formatMoney(line.totalMinor, quote.currency, locale)}`,
    );
  }
  if (services.some((service) => service.billing_type === "SUBSCRIPTION")) {
    lines.push(
      isAr
        ? "الخدمات الشهرية تُجدَّد تلقائيًا حسب المدة المتفق عليها، ويمكنك إيقاف التجديد في أي وقت."
        : "Monthly services renew according to the agreed period, and you can stop renewal at any time.",
    );
  }
  if (profile.budgetMaxMinor && quote.totalMinor > profile.budgetMaxMinor) {
    lines.push(
      isAr
        ? "ملاحظة: السعر أعلى قليلًا من الميزانية التي ذكرتها، ويمكننا تعديل النطاق ليتوافق معها."
        : "Note: this is slightly above the budget you mentioned — we can adjust the scope to match it.",
    );
  }
  return lines.join("\n");
}

function describeUnit(unit: ServiceRow["unit"], locale: Locale): string {
  const arabic: Record<ServiceRow["unit"], string> = {
    PROJECT: "مشروع",
    MONTH: "شهر",
    POST: "منشور",
    DESIGN: "تصميم",
    CAMPAIGN: "حملة",
    HOUR: "ساعة",
    REPORT: "تقرير",
  };
  const english: Record<ServiceRow["unit"], string> = {
    PROJECT: "project(s)",
    MONTH: "month(s)",
    POST: "post(s)",
    DESIGN: "design(s)",
    CAMPAIGN: "campaign(s)",
    HOUR: "hour(s)",
    REPORT: "report(s)",
  };
  return locale === "ar" ? arabic[unit] : english[unit];
}
