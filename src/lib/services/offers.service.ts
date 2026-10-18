import { addDays, nowIso, toDateKey } from "@/lib/core/date";
import { NotFoundError, PreconditionError, ValidationError } from "@/lib/core/errors";
import { formatReference, nextSequence } from "@/lib/core/ids";
import { formatMoney, marginPct } from "@/lib/core/money";
import { assertCustomerAccess, requireCapability, type Actor } from "@/lib/auth/permissions";
import type { CustomerRow, Locale, OfferItemRow, OfferRow, OfferStatus, OfferWithItems } from "@/lib/domain/types";
import { buildQuote, type QuoteResult } from "@/lib/domain/pricing";
import { listServices } from "@/lib/repositories/catalog.repo";
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
  /** Explicit unique code (e.g. OFOQ-2026-001 from the Offers Agent). */
  code?: string;
}

/** Factor reasons plus escalation codes, so staff can see exactly why a price is what it is. */
function buildPricingReason(quote: QuoteResult): string {
  const escalations = quote.escalations.map((entry) => `escalation:${entry.code}`);
  return [...quote.reasons, ...escalations].join(" | ");
}

export async function createOfferFromQuote(input: CreateOfferInput): Promise<OfferWithItems> {
  const settings = await getAgencySettings();
  const codes = await listOfferCodes();
  const code = input.code ?? formatReference("O", nextSequence(codes, "O"));
  if (codes.includes(code)) throw new ValidationError(`Offer code ${code} already exists`, { field: "code" });
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

function isExpired(offer: OfferRow): boolean {
  return Boolean(offer.valid_until && offer.valid_until <= nowIso());
}

function assertPriced(offer: OfferRow): void {
  if (offer.total_minor === null || offer.subtotal_minor === null) {
    throw new PreconditionError("This offer has no published price and cannot be sent or approved yet");
  }
}

/**
 * Owner/partner approval to send — the ONLY path from DRAFT to SENT.
 *
 * No agent and no client can send an offer: the actor must be staff with
 * `offers.manage`. Sending never sends real email; it only publishes the
 * offer to the client (dashboard/chat), which is the v1 delivery channel.
 */
export async function approveAndSendOffer(offerId: string, actor: Actor): Promise<OfferWithItems> {
  requireCapability(actor, "offers.manage");
  const offer = await findOfferById(offerId);
  if (!offer) throw new NotFoundError("Offer not found");
  if (offer.status !== "DRAFT") {
    throw new PreconditionError(`Only a draft offer can be approved and sent (current: ${offer.status})`);
  }
  assertPriced(offer);
  if (isExpired(offer)) throw new PreconditionError("This offer has expired; extend its validity before sending");

  await updateOffer(offerId, { status: "SENT" });
  await logActivity({
    actor_type: "USER",
    actor_user_id: actor.id,
    action: "offer.owner_approved_and_sent",
    entity_type: "offer",
    entity_id: offerId,
    customer_id: offer.customer_id,
    summary: `Offer ${offer.code} approved by owner/partner and sent to the client`,
  });
  return (await findOfferById(offerId))!;
}

/** Backwards-compatible name; now strictly the owner-approved send above. */
export async function sendOffer(offerId: string, actor: Actor): Promise<OfferWithItems> {
  return approveAndSendOffer(offerId, actor);
}

export interface DraftOfferLineEdit { serviceSlug: string; quantity?: number; months?: number | null }
export interface UpdateDraftOfferInput {
  lines?: DraftOfferLineEdit[];
  clientNote?: string | null;
  internalNote?: string | null;
  validForDays?: number;
}

/**
 * Owner/partner review edit of a DRAFT offer. Prices are never taken from the
 * caller: replacement lines are re-priced through the deterministic pricing
 * engine from the service catalogue, so neither staff UI nor AI can invent a
 * price through this path.
 */
export async function updateDraftOffer(
  offerId: string,
  actor: Actor,
  input: UpdateDraftOfferInput,
): Promise<OfferWithItems> {
  requireCapability(actor, "offers.manage");
  const offer = await findOfferById(offerId);
  if (!offer) throw new NotFoundError("Offer not found");
  if (offer.status !== "DRAFT") {
    throw new PreconditionError(`Only a draft offer can be edited (current: ${offer.status})`);
  }

  const patch: Partial<OfferRow> = {};
  if (input.clientNote !== undefined) patch.client_note = input.clientNote;
  if (input.internalNote !== undefined) patch.internal_note = input.internalNote;
  if (input.validForDays !== undefined) {
    if (!Number.isFinite(input.validForDays) || input.validForDays <= 0) {
      throw new ValidationError("validForDays must be a positive number", { field: "validForDays" });
    }
    patch.valid_until = addDays(new Date(), input.validForDays).toISOString();
  }

  if (input.lines !== undefined) {
    if (input.lines.length === 0) throw new ValidationError("An offer needs at least one line", { field: "lines" });
    const services = await listServices({ activeOnly: true });
    const lines = input.lines.map((line) => {
      const service = services.find((row) => row.slug === line.serviceSlug);
      if (!service) throw new ValidationError(`Unknown service: ${line.serviceSlug}`, { field: "lines" });
      return { service, quantity: line.quantity ?? 1, months: line.months ?? null };
    });
    const quote = buildQuote({ lines });
    await deleteOfferItems(offerId);
    let sortOrder = 0;
    for (const line of quote.lines) {
      await addOfferItem({
        offer_id: offerId, service_id: line.serviceId, description_ar: line.nameAr, description_en: line.nameEn,
        quantity: line.quantity, unit_price_minor: line.unitPriceMinor, billing_type: line.billingType,
        months: line.months, total_minor: line.totalMinor, sort_order: sortOrder,
      });
      sortOrder += 1;
    }
    patch.subtotal_minor = quote.subtotalMinor;
    patch.discount_minor = quote.discountMinor;
    patch.total_minor = quote.totalMinor;
    patch.internal_cost_minor = quote.internalCostMinor;
    patch.margin_pct = marginPct(quote.totalMinor, quote.internalCostMinor);
    patch.pricing_reason = buildPricingReason(quote);
    patch.pricing_breakdown = JSON.stringify({ breakdown: quote.breakdown, escalations: quote.escalations, editedByOwner: true });
    patch.currency = quote.currency;
  }

  if (Object.keys(patch).length) await updateOffer(offerId, patch);
  await logActivity({
    actor_type: "USER", actor_user_id: actor.id, action: "offer.draft_edited",
    entity_type: "offer", entity_id: offerId, customer_id: offer.customer_id,
    summary: `Draft offer ${offer.code} edited by owner/partner`,
    meta: { repriced: input.lines !== undefined },
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
  actor: Actor,
  options: { projectId?: string | null } = {},
): Promise<OfferDecision> {
  const offer = await findOfferById(offerId);
  if (!offer) throw new NotFoundError("Offer not found");
  // Only the owning client may accept; staff acceptance on a client's behalf
  // is deliberately not allowed through the client decision path.
  if (actor.role !== "CLIENT") throw new PreconditionError("Only the client can accept an offer");
  assertCustomerAccess(actor, offer.customer_id);
  if (offer.status === "APPROVED") {
    return { offer, projectId: offer.project_id, invoiceId: null };
  }
  if (offer.status !== "SENT") {
    throw new PreconditionError("Only a sent offer can be approved");
  }
  if (isExpired(offer)) {
    await updateOffer(offerId, { status: "EXPIRED" });
    throw new PreconditionError("This offer has expired");
  }
  assertPriced(offer);
  const actorUserId = actor.id;
  const pricedOffer: typeof offer & { total_minor: number; subtotal_minor: number } = {
    ...offer,
    total_minor: offer.total_minor as number,
    subtotal_minor: offer.subtotal_minor as number,
  };

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
  actor: Actor,
  reason?: string,
): Promise<OfferWithItems> {
  const offer = await findOfferById(offerId);
  if (!offer) throw new NotFoundError("Offer not found");
  if (actor.role !== "CLIENT") throw new PreconditionError("Only the client can reject an offer");
  assertCustomerAccess(actor, offer.customer_id);
  if (offer.status !== "SENT") {
    throw new PreconditionError("Only a sent offer can be rejected");
  }
  await updateOffer(offerId, { status: "REJECTED", rejected_at: nowIso(), internal_note: reason ?? offer.internal_note });
  await logActivity({
    actor_type: "USER",
    actor_user_id: actor.id,
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
  actor: Actor,
  note?: string,
): Promise<OfferWithItems> {
  requireCapability(actor, "offers.manage");
  const offer = await findOfferById(offerId);
  if (!offer) throw new NotFoundError("Offer not found");
  if (offer.status !== "DRAFT") {
    throw new PreconditionError("Only a draft offer can be revised; a sent offer needs a new offer instead.");
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
    // A revision returns to DRAFT: it must be owner-approved again before sending.
    status: "DRAFT",
    valid_until: addDays(new Date(), 14).toISOString(),
    internal_note: note ?? offer.internal_note,
  });

  await logActivity({
    actor_type: "USER",
    actor_user_id: actor.id,
    actor_label: null,
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

/** Actor-scoped read: staff see everything; a client only their own offer, and only once SENT+. */
export async function getOfferForActor(offerId: string, actor: Actor): Promise<OfferWithItems> {
  requireCapability(actor, "offers.view");
  const offer = await getOffer(offerId);
  assertCustomerAccess(actor, offer.customer_id);
  if (actor.role === "CLIENT" && offer.status === "DRAFT") throw new NotFoundError("Offer not found");
  return offer;
}

/** Actor-scoped client view (no internal cost/margin/notes — see toClientOfferView). */
export async function getClientOfferView(offerId: string, actor: Actor, locale: Locale) {
  const offer = await getOfferForActor(offerId, actor);
  return toClientOfferView(offer, locale);
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
