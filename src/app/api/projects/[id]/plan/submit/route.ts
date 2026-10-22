import { z } from "zod";

import { requireCapability } from "@/lib/auth/permissions";
import { resolveRouteActor, routeErrorResponse, routeUnauthenticated } from "@/lib/auth/route-actor";
import { ValidationError } from "@/lib/core/errors";
import { submitPlanForApproval } from "@/lib/services/project-plans.service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const submitSchema = z.object({
  note: z.string().trim().max(2000).nullable().optional(),
});

/**
 * POST /api/projects/[id]/plan/submit — send the draft plan to the owner.
 *
 * The owner is notified inside the app (no email is sent) and the project keeps
 * its current state: only an explicit approval turns the plan into a
 * commitment.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const resolved = await resolveRouteActor(request);
    if (!resolved) return routeUnauthenticated();
    requireCapability(resolved.actor, "projects.manage");
    const { id } = await params;
    const parsed = submitSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) throw new ValidationError("Invalid request", { issues: parsed.error.issues.length });

    const plan = await submitPlanForApproval(id, resolved.actor, { note: parsed.data.note ?? null });
    return Response.json(
      { data: { id: plan.id, version: plan.version, status: plan.status } },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return routeErrorResponse(error, "projects-api");
  }
}
