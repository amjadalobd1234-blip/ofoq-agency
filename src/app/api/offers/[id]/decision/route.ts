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
 * this, only on a sent, unexpired offer. `accept` marks the offer APPROVED
 * and issues an invoice through the existing billing service (which also
 * notifies the client by email through the configured mail provider — in
 * unconfigured environments that is a console log, never a real send). No
 * payment is taken or charged here. `reject` marks it REJECTED.
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
        { data: { id: decision.offer.id, code: decision.offer.code, status: decision.offer.status, invoiceId: decision.invoiceId } },
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
