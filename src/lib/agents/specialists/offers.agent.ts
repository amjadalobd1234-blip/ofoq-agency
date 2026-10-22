import { addDays } from "@/lib/core/date";
import { ConfigurationError } from "@/lib/core/errors";
import { formatOfferCode, nextOfferSequence } from "@/lib/core/ids";
import { formatMoney } from "@/lib/core/money";
import type { CustomerRow, Locale, OfferWithItems } from "@/lib/domain/types";
import { listOfferCodes } from "@/lib/repositories/offers.repo";
import { createOfferFromQuote, toClientOfferView } from "@/lib/services/offers.service";
import { getAgencySettings } from "@/lib/services/settings.service";

import { runAgent } from "../runtime";
import type { RequirementProfile } from "./needs.agent";
import { priceRequirements } from "./pricing.agent";

/**
 * Offers Agent (وكيل العروض) — v1, deliberately simple.
 *
 * When a client asks for a formal offer, this agent:
 *   1. prices the request ONLY through the existing Pricing Agent
 *      (`priceRequirements` → deterministic pricing engine). It accepts no
 *      price, discount or total from a caller or from an AI model, and it
 *      never invents one;
 *   2. creates a DRAFT offer numbered `OFOQ-<year>-<seq>` on the existing
 *      `offers` / `offer_items` tables (no new tables);
 *   3. attaches bilingual service terms and an expiry date;
 *   4. stops. Sending requires owner/partner approval
 *      (`approveAndSendOffer`), and accepting/rejecting is the client's
 *      decision (`approveOffer` / `rejectOffer`) — never the agent's.
 *
 * Internal costs and margins stay on the offer row for staff only; the
 * client-facing rendering goes through `toClientOfferView`, which strips them.
 */
export const OFFERS_AGENT_KEY = "offers" as const;
export const DEFAULT_OFFER_VALID_DAYS = 14;

export interface FormalOfferRequest {
  customer: CustomerRow;
  profile: RequirementProfile;
  locale?: Locale;
  validForDays?: number;
  createdByUserId?: string | null;
}

export interface FormalOfferResult {
  offer: OfferWithItems;
  /** Client-safe view: services, USD prices, terms and expiry — no internal data. */
  clientView: Awaited<ReturnType<typeof toClientOfferView>>;
  requiresOwnerApproval: true;
  sentToClient: false;
}

/** Bilingual service terms attached to every formal offer (client_note). */
export function buildOfferTerms(
  locale: Locale,
  validUntilIso: string,
  policies: { cancellationAr: string; cancellationEn: string; refundAr: string; refundEn: string },
): string {
  const validUntil = validUntilIso.slice(0, 10);
  if (locale === "ar") {
    return [
      `هذا العرض صالح حتى ${validUntil}، وبعد هذا التاريخ قد تتغيّر الأسعار.`,
      "جميع الأسعار بالدولار الأمريكي (USD) ما لم يُذكر خلاف ذلك.",
      "الأسعار لا تشمل ميزانية الإعلانات المدفوعة على المنصات إلا إذا ذُكر خلاف ذلك صراحةً.",
      "يبدأ العمل بعد قبول العرض وترتيب الدفع المتفق عليه، ولا يُعدّ العرض مقبولًا قبل قبول العميل الصريح.",
      `سياسة الإلغاء: ${policies.cancellationAr}`,
      `سياسة الاسترجاع: ${policies.refundAr}`,
    ].join("\n");
  }
  return [
    `This offer is valid until ${validUntil}; prices may change after that date.`,
    "All prices are in US dollars (USD) unless stated otherwise.",
    "Prices exclude paid-platform ad budgets unless explicitly stated otherwise.",
    "Work starts after the offer is accepted and the agreed payment is arranged; the offer is not accepted until the client explicitly accepts it.",
    `Cancellation policy: ${policies.cancellationEn}`,
    `Refund policy: ${policies.refundEn}`,
  ].join("\n");
}

/** Creates the formal offer DRAFT. Never sends it. */
export async function createFormalOfferDraft(input: FormalOfferRequest): Promise<FormalOfferResult> {
  const locale = input.locale ?? input.customer.locale ?? "ar";
  const validForDays = input.validForDays ?? DEFAULT_OFFER_VALID_DAYS;
  const validUntil = addDays(new Date(), validForDays).toISOString();

  // Prices come exclusively from the existing Pricing Agent. No price field
  // exists on FormalOfferRequest, so there is nothing for an AI to invent.
  const pricing = await priceRequirements(input.customer, input.profile);

  // Fail closed when the catalogue has no active service to price against.
  // Without this guard the pricing agent returns an empty quote and the offer
  // is created with a total of 0 and no line items — a zero-value "official"
  // offer that the owner can send and the client can accept. A price of zero is
  // never a published price: it means the catalogue was not seeded (or was
  // deactivated), which is a deployment problem the operator must see.
  if (pricing.services.length === 0) {
    throw new ConfigurationError(
      "The service catalogue has no active service to price this offer against. " +
        "Load the baseline catalogue (`npm run db:seed` against the platform database) " +
        "before issuing a formal offer; no offer was created.",
      { reason: "empty_service_catalogue", services: input.profile.services.slice(0, 10) },
    );
  }

  if (!Number.isFinite(pricing.quote.totalMinor) || pricing.quote.totalMinor <= 0) {
    throw new ConfigurationError(
      "The pricing engine produced no publishable total for this offer (0 or invalid). " +
        "Review the service catalogue prices before issuing a formal offer; no offer was created.",
      { reason: "unpublishable_quote_total" },
    );
  }

  const settings = await getAgencySettings();
  const code = formatOfferCode(nextOfferSequence(await listOfferCodes()));

  const offer = await createOfferFromQuote({
    customer: input.customer,
    quote: pricing.quote,
    locale,
    validForDays,
    createdByAgent: OFFERS_AGENT_KEY,
    createdByUserId: input.createdByUserId ?? null,
    clientNote: buildOfferTerms(locale, validUntil, {
      cancellationAr: settings.cancellationPolicyAr,
      cancellationEn: settings.cancellationPolicyEn,
      refundAr: settings.refundPolicyAr,
      refundEn: settings.refundPolicyEn,
    }),
    send: false,
    code,
  });

  await runAgent(
    OFFERS_AGENT_KEY,
    {
      trigger: "offer.formal_requested",
      locale,
      customerId: input.customer.id,
      projectId: offer.project_id,
      actorUserId: input.createdByUserId ?? null,
      input: { offerId: offer.id, code: offer.code, services: pricing.services.map((s) => s.slug) },
    },
    async ({ record }) => {
      record({
        action: "offer.draft_created",
        summary: `مسودة عرض رسمي ${offer.code} — ${formatMoney(offer.total_minor, offer.currency, locale)} بانتظار موافقة المالك`,
        reason: pricing.quote.reasons.slice(0, 10).join(" | "),
        entityType: "offer",
        entityId: offer.id,
        riskLevel: pricing.quote.riskLevel,
        requiresApproval: true,
        payload: { code: offer.code, totalMinor: offer.total_minor, currency: offer.currency, validUntil: offer.valid_until },
      });
      return {
        data: { offerId: offer.id, code: offer.code, status: offer.status },
        summary: `مسودة عرض ${offer.code} بانتظار موافقة المالك قبل الإرسال`,
        riskLevel: pricing.quote.riskLevel,
      };
    },
  );

  return { offer, clientView: await toClientOfferView(offer, locale), requiresOwnerApproval: true, sentToClient: false };
}
