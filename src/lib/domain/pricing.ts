import { clampMinor, marginPct, percentOf, round, sumMinor } from "@/lib/core/money";
import type { BillingType, ServiceRow, ServiceUnit } from "./types";

/**
 * Agency pricing engine.
 *
 * The agency is new and has NO historical project data, so prices are derived
 * from explicit, auditable policy inputs instead of fabricated analytics:
 *
 *     price = base_price
 *           × volume_factor        (quantity of posts/designs/months)
 *           × platforms_factor     (number of platforms handled)
 *           × complexity_factor    (how hard the work is)
 *           × urgency_factor       (compressed delivery window)
 *           × revisions_factor     (revisions beyond the included count)
 *           × market_factor        (country/market — POLICY DEFAULT, editable)
 *           × currency_factor      (only when quoting outside the service currency)
 *
 * Every factor is a documented policy default held in code or in the service's
 * `pricing_config` JSON column, and every applied factor is recorded in the
 * quote breakdown (`reasons`) so the owner can see exactly why a price was
 * produced. Nothing here is presented as real market data.
 */

export interface PricingPolicy {
  /** Share of the price that is internal cost (used only to compute margin). */
  internalCostRatio: number;
  /** Margin below this escalates to a human even if the price itself is fine. */
  minimumMarginPercent: number;
  /** Totals above this always need owner/partner approval. */
  escalationThresholdMinor: number;
  /** Maximum discount an agent may apply without approval (percentage). */
  maxAutoDiscountPercent: number;
  /** Default number of revisions included before extra fees apply. */
  defaultRevisionsIncluded: number;
  /** Fee per extra revision, as a share of the base price. */
  extraRevisionFeeRatio: number;
  /** Market factors by ISO country code — POLICY DEFAULTS, editable. */
  marketFactors: Record<string, number>;
  /** Urgency bands: maximum delivery days → multiplier. */
  urgencyBands: { maxDays: number; factor: number; labelAr: string; labelEn: string }[];
}

export const DEFAULT_PRICING_POLICY: PricingPolicy = {
  internalCostRatio: 0.55,
  minimumMarginPercent: 25,
  escalationThresholdMinor: 500_000,
  maxAutoDiscountPercent: 10,
  defaultRevisionsIncluded: 2,
  extraRevisionFeeRatio: 0.08,
  // Neutral by default: 1.0 everywhere until the agency sets its own policy.
  // The few entries below are common starting points, not measured data.
  marketFactors: {
    DEFAULT: 1,
    IQ: 1,
    AE: 1.15,
    SA: 1.15,
    QA: 1.15,
    KW: 1.15,
    JO: 1,
    EG: 0.85,
    TR: 0.85,
    US: 1.3,
    GB: 1.3,
    DE: 1.25,
    CA: 1.25,
    AU: 1.25,
  },
  urgencyBands: [
    { maxDays: 3, factor: 1.5, labelAr: "تسليم عاجل جدًا (٣ أيام أو أقل)", labelEn: "Very urgent (3 days or less)" },
    { maxDays: 7, factor: 1.25, labelAr: "تسليم سريع (أسبوع)", labelEn: "Fast delivery (one week)" },
    { maxDays: 30, factor: 1, labelAr: "تسليم معتاد (حتى شهر)", labelEn: "Standard delivery (up to a month)" },
    { maxDays: 3650, factor: 0.95, labelAr: "تسليم مرن", labelEn: "Flexible delivery" },
  ],
};

export type ComplexityLevel = "SIMPLE" | "STANDARD" | "ADVANCED" | "ENTERPRISE";

export const COMPLEXITY_FACTORS: Record<ComplexityLevel, { factor: number; labelAr: string; labelEn: string }> = {
  SIMPLE: { factor: 0.85, labelAr: "بسيط", labelEn: "Simple" },
  STANDARD: { factor: 1, labelAr: "معتاد", labelEn: "Standard" },
  ADVANCED: { factor: 1.35, labelAr: "متقدم", labelEn: "Advanced" },
  ENTERPRISE: { factor: 1.8, labelAr: "مؤسسي", labelEn: "Enterprise" },
};

export interface PricingRequestLine {
  service: ServiceRow;
  quantity?: number;
  months?: number | null;
  complexity?: ComplexityLevel;
  deliveryDays?: number | null;
  revisions?: number | null;
}

export interface PricingRequest {
  lines: PricingRequestLine[];
  platforms?: string[];
  countries?: string[];
  languages?: string[];
  /** Client's stated budget ceiling, in minor units, when known. */
  budgetMaxMinor?: number | null;
  /** Requested discount percentage, when the client or staff asked for one. */
  requestedDiscountPercent?: number;
  currency?: string;
  policy?: Partial<PricingPolicy>;
}

export interface QuoteLineResult {
  serviceId: string;
  slug: string;
  nameAr: string;
  nameEn: string;
  unit: ServiceUnit;
  billingType: BillingType;
  quantity: number;
  months: number | null;
  unitPriceMinor: number;
  totalMinor: number;
  deliveryDays: number;
  revisionsIncluded: number;
  factors: { key: string; factor: number; labelAr: string; labelEn: string }[];
  reasons: string[];
}

export interface QuoteResult {
  currency: string;
  lines: QuoteLineResult[];
  subtotalMinor: number;
  discountMinor: number;
  totalMinor: number;
  internalCostMinor: number;
  marginPct: number | null;
  deliveryDays: number;
  revisionRounds: number;
  /** Human-readable explanation of every factor applied. */
  breakdown: { labelAr: string; labelEn: string; value: string }[];
  /** Machine-readable reasons kept with the offer row. */
  reasons: string[];
  /** Cases that must be reviewed by the owner/partner. */
  escalations: { code: string; messageAr: string; messageEn: string }[];
  requiresApproval: boolean;
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
}

export function mergePolicy(overrides?: Partial<PricingPolicy>): PricingPolicy {
  return { ...DEFAULT_PRICING_POLICY, ...(overrides ?? {}) };
}

/** Reads per-service overrides from the `pricing_config` JSON column. */
export function servicePolicyOverrides(service: ServiceRow): Partial<PricingPolicy> | undefined {
  if (!service.pricing_config) return undefined;
  try {
    const parsed = JSON.parse(service.pricing_config) as Partial<PricingPolicy>;
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function volumeFactor(service: ServiceRow, quantity: number): { factor: number; reason: string } {
  if (quantity <= 1) return { factor: 1, reason: "" };
  // Volume discounts that scale with the unit of work; documented policy, not
  // observed data.
  switch (service.unit) {
    case "POST":
    case "DESIGN":
      if (quantity >= 30) return { factor: 0.78, reason: `volume:${quantity}:0.78` };
      if (quantity >= 20) return { factor: 0.85, reason: `volume:${quantity}:0.85` };
      if (quantity >= 12) return { factor: 0.9, reason: `volume:${quantity}:0.9` };
      if (quantity >= 8) return { factor: 0.95, reason: `volume:${quantity}:0.95` };
      return { factor: 1, reason: "" };
    case "MONTH":
    case "CAMPAIGN":
      if (quantity >= 12) return { factor: 0.88, reason: `volume:${quantity}:0.88` };
      if (quantity >= 6) return { factor: 0.92, reason: `volume:${quantity}:0.92` };
      if (quantity >= 3) return { factor: 0.96, reason: `volume:${quantity}:0.96` };
      return { factor: 1, reason: "" };
    default:
      return { factor: 1, reason: "" };
  }
}

function platformsFactor(platforms: string[] | undefined): { factor: number; reason: string } {
  const count = platforms?.length ?? 0;
  if (count <= 1) return { factor: 1, reason: "" };
  // Managing more channels multiplies coordination work, but sub-linearly.
  const extra = (count - 1) * 0.12;
  const factor = round((1 + extra) * 100) / 100;
  return { factor, reason: `platforms:${count}:${factor}` };
}

function urgencyFactor(
  requestedDays: number | null | undefined,
  policy: PricingPolicy,
): { factor: number; reason: string; labelAr: string; labelEn: string } | null {
  if (!requestedDays) return null;
  const band = policy.urgencyBands.find((entry) => requestedDays <= entry.maxDays);
  if (!band || band.factor === 1) return band ? { factor: 1, reason: "", labelAr: band.labelAr, labelEn: band.labelEn } : null;
  return {
    factor: band.factor,
    reason: `urgency:${requestedDays}d:${band.factor}`,
    labelAr: band.labelAr,
    labelEn: band.labelEn,
  };
}

function revisionsFactor(
  revisions: number | null | undefined,
  included: number,
  policy: PricingPolicy,
): { factor: number; reason: string } {
  if (!revisions || revisions <= included) return { factor: 1, reason: "" };
  const extra = revisions - included;
  const factor = round((1 + extra * policy.extraRevisionFeeRatio) * 100) / 100;
  return { factor, reason: `revisions:+${extra}:${factor}` };
}

function marketFactor(countries: string[] | undefined, policy: PricingPolicy): { factor: number; reason: string; country: string | null } {
  const country = countries?.[0]?.toUpperCase();
  if (!country) return { factor: policy.marketFactors.DEFAULT ?? 1, reason: "", country: null };
  const factor = policy.marketFactors[country] ?? policy.marketFactors.DEFAULT ?? 1;
  if (factor === 1) return { factor, reason: "", country };
  return { factor, reason: `market:${country}:${factor}`, country };
}

/**
 * Produces a priced quote with a full audit trail.
 * Pure function: no database access, so it is trivially unit-testable.
 */
export function buildQuote(request: PricingRequest): QuoteResult {
  const currency = request.currency ?? request.lines[0]?.service.currency ?? "USD";
  const policy = mergePolicy(request.policy);
  const lines: QuoteLineResult[] = [];
  const breakdown: QuoteResult["breakdown"] = [];
  const reasons: string[] = [];
  const escalations: QuoteResult["escalations"] = [];
  let maxDeliveryDays = 0;
  let revisionRounds = 0;

  const platformInfo = platformsFactor(request.platforms);
  const marketInfo = marketFactor(request.countries, policy);

  for (const line of request.lines) {
    const service = line.service;
    const linePolicy = mergePolicy({ ...policy, ...servicePolicyOverrides(service) });
    const quantity = Math.max(1, line.quantity ?? 1);
    const months = line.months ?? (service.billing_type === "SUBSCRIPTION" ? Math.max(1, quantity) : null);
    const complexity: ComplexityLevel = line.complexity ?? "STANDARD";
    const revisionsIncluded = service.revisions_included || linePolicy.defaultRevisionsIncluded;

    const volume = volumeFactor(service, quantity);
    /**
     * Urgency only applies when the client asks for something FASTER than the
     * service's standard delivery window. Using the service default would silently
     * inflate every standard quote.
     */
    const requestedDays = line.deliveryDays ?? null;
    const urgency =
      requestedDays !== null && requestedDays < service.delivery_days
        ? urgencyFactor(requestedDays, linePolicy)
        : null;
    const revisions = revisionsFactor(line.revisions ?? null, revisionsIncluded, linePolicy);
    const complexityInfo = COMPLEXITY_FACTORS[complexity];

    const factors: QuoteLineResult["factors"] = [];
    const lineReasons: string[] = [];

    let unitPrice = service.base_price_minor * service.complexity_factor;

    /** Records an applied factor for both display and the audit trail. */
    const applyFactor = (
      key: string,
      factor: number,
      labelAr: string,
      labelEn: string,
      reason: string,
    ) => {
      unitPrice *= factor;
      factors.push({ key, factor, labelAr, labelEn });
      lineReasons.push(reason);
    };

    factors.push({
      key: "base",
      factor: 1,
      labelAr: "السعر الأساسي للخدمة",
      labelEn: "Service base price",
    });
    lineReasons.push("base");

    if (platformInfo.factor !== 1) {
      applyFactor(
        "platforms",
        platformInfo.factor,
        `عدد المنصات (${request.platforms?.length ?? 0})`,
        `Number of platforms (${request.platforms?.length ?? 0})`,
        platformInfo.reason,
      );
    }
    if (complexityInfo.factor !== 1) {
      applyFactor(
        "complexity",
        complexityInfo.factor,
        `التعقيد: ${complexityInfo.labelAr}`,
        `Complexity: ${complexityInfo.labelEn}`,
        `complexity:${complexity}:${complexityInfo.factor}`,
      );
    }
    if (urgency && urgency.factor !== 1) {
      applyFactor(
        "urgency",
        urgency.factor,
        urgency.labelAr,
        urgency.labelEn,
        urgency.reason || `urgency:${urgency.factor}`,
      );
    }
    if (revisions.factor !== 1) {
      applyFactor("revisions", revisions.factor, "تعديلات إضافية", "Extra revisions", revisions.reason);
    }
    if (volume.factor !== 1) {
      applyFactor(
        "volume",
        volume.factor,
        `خصم الكمية (${quantity})`,
        `Volume discount (${quantity})`,
        volume.reason,
      );
    }
    if (marketInfo.factor !== 1) {
      applyFactor(
        "market",
        marketInfo.factor,
        `عامل السوق (${marketInfo.country})`,
        `Market factor (${marketInfo.country})`,
        marketInfo.reason,
      );
    }

    let lineTotal = round(unitPrice) * quantity;
    if (service.billing_type === "SUBSCRIPTION" && months && months > 1) {
      // Subscriptions are billed per period; `quantity` counts periods.
      lineTotal = round(unitPrice) * months;
    }
    if (lineTotal < service.min_price_minor) {
      escalations.push({
        code: "below_floor",
        messageAr: `السعر المحسوب للخدمة «${service.name_ar}» أقل من الحد الأدنى المسموح.`,
        messageEn: `The calculated price for "${service.name_en}" is below the configured minimum.`,
      });
      lineTotal = service.min_price_minor;
      lineReasons.push("floor-applied");
    }

    maxDeliveryDays = Math.max(maxDeliveryDays, line.deliveryDays ?? service.delivery_days);
    revisionRounds = Math.max(revisionRounds, revisionsIncluded + Math.max(0, (line.revisions ?? 0) - revisionsIncluded));

    lines.push({
      serviceId: service.id,
      slug: service.slug,
      nameAr: service.name_ar,
      nameEn: service.name_en,
      unit: service.unit,
      billingType: service.billing_type,
      quantity,
      months: service.billing_type === "SUBSCRIPTION" ? months : null,
      unitPriceMinor: round(unitPrice),
      totalMinor: clampMinor(lineTotal),
      deliveryDays: line.deliveryDays ?? service.delivery_days,
      revisionsIncluded,
      factors,
      reasons: lineReasons,
    });
  }

  const subtotal = sumMinor(lines.map((line) => line.totalMinor));
  const requestedDiscount = Math.max(0, Math.min(50, request.requestedDiscountPercent ?? 0));
  const discountMinor = requestedDiscount > 0 ? percentOf(subtotal, requestedDiscount) : 0;
  const total = clampMinor(subtotal - discountMinor);
  const internalCost = round(subtotal * policy.internalCostRatio);
  const margin = marginPct(total, internalCost);

  if (requestedDiscount > policy.maxAutoDiscountPercent) {
    escalations.push({
      code: "large_discount",
      messageAr: `الخصم المطلوب (${requestedDiscount}%) يتجاوز الحد الذي يمكن اعتماده تلقائيًا (${policy.maxAutoDiscountPercent}%).`,
      messageEn: `The requested discount (${requestedDiscount}%) exceeds the automatic limit (${policy.maxAutoDiscountPercent}%).`,
    });
  }
  if (total > policy.escalationThresholdMinor) {
    escalations.push({
      code: "large_project",
      messageAr: "قيمة المشروع كبيرة وتحتاج موافقة المالك أو الشريك قبل الإرسال.",
      messageEn: "The project value is large and needs owner or partner approval before sending.",
    });
  }
  if (margin !== null && margin < policy.minimumMarginPercent) {
    escalations.push({
      code: "thin_margin",
      messageAr: `هامش الربح (${margin}%) أقل من الحد الأدنى المحدد (${policy.minimumMarginPercent}%).`,
      messageEn: `The margin (${margin}%) is below the configured minimum (${policy.minimumMarginPercent}%).`,
    });
  }
  if (request.budgetMaxMinor && total > request.budgetMaxMinor) {
    escalations.push({
      code: "above_budget",
      messageAr: "السعر المقترح أعلى من الميزانية التي ذكرها العميل.",
      messageEn: "The suggested price is above the budget the client mentioned.",
    });
  }

  breakdown.push({ labelAr: "عدد البنود", labelEn: "Line items", value: String(lines.length) });
  if (request.platforms?.length) {
    breakdown.push({
      labelAr: "المنصات",
      labelEn: "Platforms",
      value: request.platforms.join(", "),
    });
  }
  if (request.countries?.[0]) {
    breakdown.push({ labelAr: "السوق", labelEn: "Market", value: request.countries[0] });
  }
  breakdown.push({
    labelAr: "مدة التنفيذ المتوقعة",
    labelEn: "Expected delivery",
    value: `${maxDeliveryDays} ${"days"}`,
  });
  breakdown.push({
    labelAr: "جولات التعديل المتضمنة",
    labelEn: "Included revision rounds",
    value: String(revisionRounds),
  });

  reasons.push(...lines.flatMap((line) => line.reasons.map((reason) => `${line.slug}:${reason}`)));
  if (requestedDiscount > 0) reasons.push(`discount:${requestedDiscount}%`);

  const riskLevel = escalations.some((entry) => entry.code === "large_project" || entry.code === "thin_margin")
    ? "HIGH"
    : escalations.length > 0
      ? "MEDIUM"
      : "LOW";

  return {
    currency,
    lines,
    subtotalMinor: subtotal,
    discountMinor,
    totalMinor: total,
    internalCostMinor: internalCost,
    marginPct: margin,
    deliveryDays: maxDeliveryDays || 7,
    revisionRounds,
    breakdown,
    reasons,
    escalations,
    requiresApproval: escalations.length > 0,
    riskLevel,
  };
}

/** Chooses a complexity level from objective signals in the request. */
export function inferComplexity(signals: {
  platforms?: string[];
  languages?: string[];
  postCount?: number | null;
  website?: boolean;
  integrations?: string[];
  countries?: string[];
}): ComplexityLevel {
  let score = 0;
  score += Math.max(0, (signals.platforms?.length ?? 0) - 1);
  score += Math.max(0, (signals.languages?.length ?? 1) - 1);
  score += signals.website ? 2 : 0;
  score += Math.max(0, (signals.integrations?.length ?? 0) - 1);
  score += ((signals.postCount ?? 0) >= 20 ? 1 : 0) + ((signals.postCount ?? 0) >= 40 ? 1 : 0);
  score += Math.max(0, (signals.countries?.length ?? 1) - 1);

  if (score >= 6) return "ENTERPRISE";
  if (score >= 3) return "ADVANCED";
  if (score >= 1) return "STANDARD";
  return "SIMPLE";
}
