import { offersErrorResponse, offersUnauthenticated, resolveOffersActor } from "@/lib/offers/route-actor";
import { issueInvoiceForApprovedOffer } from "@/lib/services/offers.service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/offers/[id]/invoice — the owner's explicit invoice decision.
 *
 * Separate from client acceptance: accepting an offer never issues an
 * invoice or sends email. Only staff with `invoices.manage` may call this,
 * only for an APPROVED offer, and repeat calls return the existing invoice.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const resolved = await resolveOffersActor(request);
    if (!resolved) return offersUnauthenticated();
    const { id } = await params;
    const result = await issueInvoiceForApprovedOffer(id, resolved.actor);
    return Response.json(
      { data: { offerId: result.offer.id, code: result.offer.code, status: result.offer.status, invoiceId: result.invoiceId, created: result.created } },
      { status: result.created ? 201 : 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return offersErrorResponse(error);
  }
}
