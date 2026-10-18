import { offersErrorResponse, offersUnauthenticated, resolveOffersActor } from "@/lib/offers/route-actor";
import { approveAndSendOffer } from "@/lib/services/offers.service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/offers/[id]/send — the OWNER/PARTNER approval step.
 *
 * This is the only route that moves an offer DRAFT → SENT, and the service
 * re-checks the `offers.manage` capability, draft status, price and expiry.
 * It is deliberately separate from the client's accept/reject decision, and
 * it sends no email: "sent" means published to the client inside the platform.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const resolved = await resolveOffersActor(request);
    if (!resolved) return offersUnauthenticated();
    const { id } = await params;
    const offer = await approveAndSendOffer(id, resolved.actor);
    return Response.json(
      { data: { id: offer.id, code: offer.code, status: offer.status } },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return offersErrorResponse(error);
  }
}
