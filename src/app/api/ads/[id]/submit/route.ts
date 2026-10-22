import { z } from "zod";

import { requireCapability } from "@/lib/auth/permissions";
import { resolveRouteActor, routeErrorResponse, routeUnauthenticated } from "@/lib/auth/route-actor";
import { ValidationError } from "@/lib/core/errors";
import { submitAdPlanForApproval } from "@/lib/services/ad-plans.service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const submitSchema = z.object({
  note: z.string().trim().max(2000).nullable().optional(),
});

/** POST /api/ads/[id]/submit — staff sends the draft to the owner. In-app alert only. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const resolved = await resolveRouteActor(request);
    if (!resolved) return routeUnauthenticated();
    requireCapability(resolved.actor, "campaigns.manage");
    const { id } = await params;
    const parsed = submitSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) throw new ValidationError("Invalid request", { issues: parsed.error.issues.length });

    const plan = await submitAdPlanForApproval(id, resolved.actor, { note: parsed.data.note ?? null });
    return Response.json({ data: { plan, liveExecution: false } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return routeErrorResponse(error, "ads-api");
  }
}
