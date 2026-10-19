import { z } from "zod";

import { isStaff } from "@/lib/auth/permissions";
import { ValidationError } from "@/lib/core/errors";
import { offersErrorResponse, offersUnauthenticated, resolveOffersActor } from "@/lib/offers/route-actor";
import { getOfferForActor, toClientOfferView, updateDraftOffer } from "@/lib/services/offers.service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const patchSchema = z.object({
  lines: z.array(z.object({
    serviceSlug: z.string().trim().min(1),
    quantity: z.number().positive().max(10_000).optional(),
    months: z.number().int().positive().max(120).nullable().optional(),
  })).min(1).max(20).optional(),
  clientNote: z.string().max(5000).nullable().optional(),
  internalNote: z.string().max(5000).nullable().optional(),
  validForDays: z.number().int().positive().max(365).optional(),
});

/**
 * GET /api/offers/[id] — staff read the full offer (internal figures stay
 * staff-only); the owning client reads the safe view, and never a draft.
 * PATCH /api/offers/[id] — owner/partner edit of a DRAFT. Line changes are
 * repriced from the catalogue by the service; no price is accepted here.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const resolved = await resolveOffersActor(request);
    if (!resolved) return offersUnauthenticated();
    const { id } = await params;
    const offer = await getOfferForActor(id, resolved.actor);
    const data = isStaff(resolved.actor) ? offer : await toClientOfferView(offer, resolved.customer?.locale ?? "ar");
    return Response.json({ data }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return offersErrorResponse(error);
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const resolved = await resolveOffersActor(request);
    if (!resolved) return offersUnauthenticated();
    const { id } = await params;
    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new ValidationError("Invalid offer edit", { issues: parsed.error.issues.length });
    const offer = await updateDraftOffer(id, resolved.actor, parsed.data);
    return Response.json({ data: offer }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return offersErrorResponse(error);
  }
}
