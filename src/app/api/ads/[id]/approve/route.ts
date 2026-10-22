import { z } from "zod";

import { requireCapability } from "@/lib/auth/permissions";
import { resolveRouteActor, routeErrorResponse, routeUnauthenticated } from "@/lib/auth/route-actor";
import { ValidationError } from "@/lib/core/errors";
import { approveAdPlan } from "@/lib/services/ad-plans.service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const approveSchema = z.object({
  note: z.string().trim().max(2000).nullable().optional(),
});

/**
 * POST /api/ads/[id]/approve — the owner's explicit approval.
 *
 * Approval publishes the advice to the client. It does not launch a campaign,
 * connect an ads account, or spend money.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const resolved = await resolveRouteActor(request);
    if (!resolved) return routeUnauthenticated();
    requireCapability(resolved.actor, "campaigns.plan.approve");
    const { id } = await params;
    const parsed = approveSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) throw new ValidationError("Invalid request", { issues: parsed.error.issues.length });

    const plan = await approveAdPlan(id, resolved.actor, { note: parsed.data.note ?? null });
    return Response.json(
      { data: { plan, liveExecution: false } },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return routeErrorResponse(error, "ads-api");
  }
}
