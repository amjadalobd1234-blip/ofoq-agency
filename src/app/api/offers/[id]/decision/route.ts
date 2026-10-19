import { z } from "zod";

import { ValidationError } from "@/lib/core/errors";
import { offersErrorResponse, offersUnauthenticated, resolveOffersActor } from "@/lib/offers/route-actor";
import { approveOffer, rejectOffer } from "@/lib/services/offers.service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const decisionSchema = z.object({
  decision: z.enum(["accept", "reject"]),
  reason: z.string().trim().max(1000).optional(),
});

/**
 * POST /api/offers/[id]/decision — the CLIENT's final decision on a SENT offer.
 *
 * Distinct from owner approval (`/send`): only the owning client may call
 * this, only on a sent, unexpired offer. `accept` only marks the offer
 * APPROVED and raises an internal (in-app, no-email) alert for the owner —
 * it never issues an invoice and never sends email. Invoicing is the
 * owner's separate explicit action (`POST /api/offers/[id]/invoice`).
 * `reject` marks it REJECTED.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const resolved = await resolveOffersActor(request);
    if (!resolved) return offersUnauthenticated();
    const { id } = await params;
    const parsed = decisionSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new ValidationError("Invalid decision", { issues: parsed.error.issues.length });

    if (parsed.data.decision === "accept") {
      const decision = await approveOffer(id, resolved.actor);
      return Response.json(
        { data: { id: decision.offer.id, code: decision.offer.code, status: decision.offer.status, invoiceId: decision.invoiceId, alertId: decision.alertId } },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    const offer = await rejectOffer(id, resolved.actor, parsed.data.reason);
    return Response.json(
      { data: { id: offer.id, code: offer.code, status: offer.status } },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return offersErrorResponse(error);
  }
}
