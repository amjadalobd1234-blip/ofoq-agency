import { addDays, nowIso, toDateKey } from "@/lib/core/date";
import { NotFoundError, PreconditionError } from "@/lib/core/errors";
import { formatReference, nextSequence } from "@/lib/core/ids";
import { formatMoney, marginPct } from "@/lib/core/money";
import type { CustomerRow, Locale, OfferItemRow, OfferRow, OfferStatus, OfferWithItems } from "@/lib/domain/types";
import type { QuoteResult } from "@/lib/domain/pricing";
import {
  addOfferItem,
  createOffer,
  deleteOfferItems,
  findOfferById,
  listOfferCodes,
  listOffers,
  updateOffer,
} from "@/lib/repositories/offers.repo";

import { logActivity } from "./activity.service";
import { getAgencySettings } from "./settings.service";

/**
 * Offers (proposals) lifecycle.
 *
 * An offer always carries:
 *  - the client-facing line items and total,
 *  - a pricing reason and full breakdown (internal),
 *  - the internal cost and margin (internal only — never sent to the client),
 *  - a snapshot of the cancellation/refund policy shown before payment.
 */
export interface CreateOfferInput {
  customer: CustomerRow;
  quote: QuoteResult;
  projectId?: string | null;
  locale: Locale;
  validForDays?: number;
  createdByAgent?: string | null;
  createdByUserId?: string | null;
  clientNote?: string | null;
  internalNote?: string | null;
  /** When true the offer is marked SENT immediately (used by the assistant). */
  send?: boolean;
}

/** Factor reasons plus escalation codes, so staff can see exactly why a price is what it is. */
function buildPricingReason(quote: QuoteResult): string {
  const escalations = quote.escalations.map((entry) => `escalation:${entry.code}`);
  return [...quote.reasons, ...escalations].join(" | ");
}

export async function createOfferFromQuote(input: CreateOfferInput): Promise<OfferWithItems> {
  const settings = await getAgencySettings();
  const codes = await listOfferCodes();
  const code = formatReference("O", nextSequence(codes, "O"));
  const validUntil = addDays(new Date(), input.validForDays ?? 14).toISOString();

  const offer = await createOffer({
    code,
    customer_id: input.customer.id,
    project_id: input.projectId ?? null,
    status: input.send ? "SENT" : "DRAFT",
    currency: input.quote.currency,
    subtotal_minor: input.quote.subtotalMinor,
    discount_minor: input.quote.discountMinor,
    total_minor: input.quote.totalMinor,
    internal_cost_minor: input.quote.internalCostMinor,
    margin_pct: marginPct(input.quote.totalMinor, input.quote.internalCostMinor),
    valid_until: validUntil,
    // Every price keeps its full reasoning: the applied factors AND the reason it
    // needed human review (if it did).
    pricing_reason: buildPricingReason(input.quote),
    pricing_breakdown: JSON.stringify({
      breakdown: input.quote.breakdown,
      lines: input.quote.lines.map((line) => ({
        slug: line.slug,
        quantity: line.quantity,
        months: line.months,
        unitPriceMinor: line.unitPriceMinor,
        totalMinor: line.totalMinor,
        factors: line.factors,
      })),
      escalations: input.quote.escalations,
      marginPct: input.quote.marginPct,
    }),
    client_note: input.clientNote ?? defaultClientNote(input.locale, input.quote, settings),
    internal_note: input.internalNote ?? null,
    created_by_agent: input.createdByAgent ?? null,
    created_by_user_id: input.createdByUserId ?? null,
  });

  let sortOrder = 0;
  for (const line of input.quote.lines) {
    await addOfferItem({
      offer_id: offer.id,
      service_id: line.serviceId,
      description_ar: line.nameAr,
      description_en: line.nameEn,
      quantity: line.quantity,
      unit_price_minor: line.unitPriceMinor,
      billing_type: line.billingType,
      months: line.months,
      total_minor: line.totalMinor,
      sort_order: sortOrder,
    });
    sortOrder += 1;
  }

  await logActivity({
    actor_type: input.createdByUserId ? "USER" : input.createdByAgent ? "AGENT" : "SYSTEM",
    actor_user_id: input.createdByUserId ?? null,
    actor_label: input.createdByAgent ?? null,
    action: "offer.created",
    entity_type: "offer",
    entity_id: offer.id,
    customer_id: input.customer.id,
    summary: `Offer ${offer.code} created — ${formatMoney(offer.total_minor, offer.currency, input.locale)}`,
    meta: { requiresApproval: input.quote.requiresApproval, riskLevel: input.quote.riskLevel },
  });

  const created = await findOfferById(offer.id);
  return created!;
}

function defaultClientNote(
  locale: Locale,
  quote: QuoteResult,
  settings: { cancellationPolicyAr: string; cancellationPolicyEn: string; refundPolicyAr: string; refundPolicyEn: string },
): string {
  const parts: string[] = [];
  if (locale === "ar") {
    parts.push(`مدة التنفيذ المتوقعة ${quote.deliveryDays} يوم من تاريخ البدء.`);
    parts.push(`سياسة الإلغاء: ${settings.cancellationPolicyAr}`);
    parts.push(`سياسة الاسترجاع: ${settings.refundPolicyAr}`);
    parts.push("الأسعار المذكورة لا تشمل ميزانية الإعلانات المدفوعة على المنصات إلا إذا ذُكر خلاف ذلك.");
  } else {
    parts.push(`Expected delivery ${quote.deliveryDays} days from the start date.`);
    parts.push(`Cancellation policy: ${settings.cancellationPolicyEn}`);
    parts.push(`Refund policy: ${settings.refundPolicyEn}`);
    parts.push("Prices exclude paid-platform ad budgets unless explicitly stated otherwise.");
  }
  return parts.join("\n");
}

export async function sendOffer(
  offerId: string,
  actor: { userId?: string | null; agentKey?: string | null; locale?: Locale },
): Promise<OfferWithItems> {
  const offer = await findOfferById(offerId);
  if (!offer) throw new NotFoundError("Offer not found");
  if (offer.status === "APPROVED") throw new PreconditionError("This offer was already approved");
  if (offer.status === "CANCELLED") throw new PreconditionError("This offer was cancelled");

  await updateOffer(offerId, { status: "SENT" });
  await logActivity({
    actor_type: actor.userId ? "USER" : actor.agentKey ? "AGENT" : "SYSTEM",
    actor_user_id: actor.userId ?? null,
    actor_label: actor.agentKey ?? null,
    action: "offer.sent",
    entity_type: "offer",
    entity_id: offerId,
    customer_id: offer.customer_id,
    summary: `Offer ${offer.code} sent to the client`,
  });

  return (await findOfferById(offerId))!;
}

export interface OfferDecision {
  offer: OfferWithItems;
  projectId: string | null;
  invoiceId: string | null;
}

/**
 * Client approves an offer: the project moves to "awaiting payment" and an
 * invoice is issued. Nothing is charged automatically — payment happens through
 * the configured provider or a manually recorded transfer.
 */
export async function approveOffer(
  offerId: string,
  actorUserId: string,
  options: { projectId?: string | null } = {},
): Promise<OfferDecision> {
  const offer = await findOfferById(offerId);
  if (!offer) throw new NotFoundError("Offer not found");
  if (offer.status === "APPROVED") {
    return { offer, projectId: offer.project_id, invoiceId: null };
  }
  if (offer.status !== "SENT" && offer.status !== "DRAFT") {
    throw new PreconditionError("Only a sent offer can be approved");
  }
  if (offer.total_minor === null || offer.subtotal_minor === null) {
    throw new PreconditionError("This request has no published price and cannot be approved or invoiced yet");
  }
  const pricedOffer = { ...offer, total_minor: offer.total_minor, subtotal_minor: offer.subtotal_minor };

  await updateOffer(offerId, { status: "APPROVED", approved_at: nowIso() });

  const { createInvoiceFromOffer } = await import("./billing.service");
  const { updateProject } = await import("@/lib/repositories/projects.repo");

  const projectId = options.projectId ?? offer.project_id ?? null;
  if (projectId) {
    await updateProject(projectId, { status: "AWAITING_PAYMENT" });
  }

  const invoice = await createInvoiceFromOffer(pricedOffer, { actorUserId });

  await logActivity({
    actor_type: "USER",
    actor_user_id: actorUserId,
    action: "offer.approved",
    entity_type: "offer",
    entity_id: offerId,
    customer_id: offer.customer_id,
    summary: `Client approved offer ${offer.code}`,
    meta: { invoiceId: invoice.id, projectId },
  });

  const updated = await findOfferById(offerId);
  return { offer: updated!, projectId, invoiceId: invoice.id };
}

export async function rejectOffer(
  offerId: string,
  actorUserId: string,
  reason?: string,
): Promise<OfferWithItems> {
  const offer = await findOfferById(offerId);
  if (!offer) throw new NotFoundError("Offer not found");
  await updateOffer(offerId, { status: "REJECTED", rejected_at: nowIso(), internal_note: reason ?? null });
  await logActivity({
    actor_type: "USER",
    actor_user_id: actorUserId,
    action: "offer.rejected",
    entity_type: "offer",
    entity_id: offerId,
    customer_id: offer.customer_id,
    summary: `Offer ${offer.code} rejected`,
    meta: { reason },
  });
  return (await findOfferById(offerId))!;
}

/** Rebuilds an offer from an updated quote (used after a revision request). */
export async function reviseOffer(
  offerId: string,
  quote: QuoteResult,
  actor: { userId?: string | null; agentKey?: string | null },
  note?: string,
): Promise<OfferWithItems> {
  const offer = await findOfferById(offerId);
  if (!offer) throw new NotFoundError("Offer not found");
  if (offer.status === "APPROVED") {
    throw new PreconditionError("An approved offer cannot be edited. Create a new offer instead.");
  }

  await deleteOfferItems(offerId);
  let sortOrder = 0;
  for (const line of quote.lines) {
    await addOfferItem({
      offer_id: offerId,
      service_id: line.serviceId,
      description_ar: line.nameAr,
      description_en: line.nameEn,
      quantity: line.quantity,
      unit_price_minor: line.unitPriceMinor,
      billing_type: line.billingType,
      months: line.months,
      total_minor: line.totalMinor,
      sort_order: sortOrder,
    });
    sortOrder += 1;
  }

  await updateOffer(offerId, {
    subtotal_minor: quote.subtotalMinor,
    discount_minor: quote.discountMinor,
    total_minor: quote.totalMinor,
    internal_cost_minor: quote.internalCostMinor,
    margin_pct: marginPct(quote.totalMinor, quote.internalCostMinor),
    pricing_reason: buildPricingReason(quote),
    pricing_breakdown: JSON.stringify({ breakdown: quote.breakdown, escalations: quote.escalations }),
    status: "SENT",
    valid_until: addDays(new Date(), 14).toISOString(),
    internal_note: note ?? offer.internal_note,
  });

  await logActivity({
    actor_type: actor.userId ? "USER" : "AGENT",
    actor_user_id: actor.userId ?? null,
    actor_label: actor.agentKey ?? null,
    action: "offer.revised",
    entity_type: "offer",
    entity_id: offerId,
    customer_id: offer.customer_id,
    summary: `Offer ${offer.code} revised`,
    meta: { totalMinor: quote.totalMinor },
  });

  return (await findOfferById(offerId))!;
}

export async function listCustomerOffers(
  customerId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<{ rows: OfferWithItems[]; total: number }> {
  return listOffers({ customerId, ...options });
}

export async function getOffer(offerId: string): Promise<OfferWithItems> {
  const offer = await findOfferById(offerId);
  if (!offer) throw new NotFoundError("Offer not found");
  return offer;
}

export async function expireOldOffers(): Promise<number> {
  const { listExpiredSentOffers } = await import("@/lib/repositories/offers.repo");
  const expired = await listExpiredSentOffers();
  for (const offer of expired) {
    await updateOffer(offer.id, { status: "EXPIRED" as OfferStatus });
  }
  return expired.length;
}

/** Client-facing view: hides internal cost, margin and internal notes. */
export interface ClientOfferView {
  id: string;
  code: string;
  status: OfferStatus;
  currency: string;
  totalMinor: number | null;
  subtotalMinor: number | null;
  discountMinor: number;
  validUntil: string | null;
  clientNote: string | null;
  items: Pick<OfferItemRow, "description_ar" | "description_en" | "quantity" | "unit_price_minor" | "total_minor" | "billing_type" | "months">[];
  canApprove: boolean;
  canReject: boolean;
  policyNote: string;
}

export async function toClientOfferView(offer: OfferWithItems, locale: Locale): Promise<ClientOfferView> {
  const settings = await getAgencySettings();
  const policyNote =
    locale === "ar"
      ? `${settings.cancellationPolicyAr}\n${settings.refundPolicyAr}`
      : `${settings.cancellationPolicyEn}\n${settings.refundPolicyEn}`;
  return {
    id: offer.id,
    code: offer.code,
    status: offer.status,
    currency: offer.currency,
    totalMinor: offer.total_minor,
    subtotalMinor: offer.subtotal_minor,
    discountMinor: offer.discount_minor,
    validUntil: offer.valid_until,
    clientNote: offer.client_note,
    items: offer.items.map((item) => ({
      description_ar: item.description_ar,
      description_en: item.description_en,
      quantity: item.quantity,
      unit_price_minor: item.unit_price_minor,
      total_minor: item.total_minor,
      billing_type: item.billing_type,
      months: item.months,
    })),
    canApprove: offer.total_minor !== null && offer.subtotal_minor !== null && offer.status === "SENT" && (!offer.valid_until || offer.valid_until > nowIso()),
    canReject: offer.status === "SENT",
    policyNote,
  };
}

export function offerValidityLabel(offer: OfferRow, locale: Locale): string {
  if (!offer.valid_until) return locale === "ar" ? "بدون تاريخ انتهاء" : "No expiry";
  return toDateKey(offer.valid_until);
}
