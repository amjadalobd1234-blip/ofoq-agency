import { z } from "zod";

import { requireCapability } from "@/lib/auth/permissions";
import { resolveRouteActor, routeErrorResponse, routeUnauthenticated } from "@/lib/auth/route-actor";
import { ValidationError } from "@/lib/core/errors";
import { approvePlan } from "@/lib/services/project-plans.service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const approveSchema = z.object({
  note: z.string().trim().max(2000).nullable().optional(),
});

/**
 * POST /api/projects/[id]/plan/approve — the owner's explicit approval.
 *
 * The route requires `projects.plan.approve`, which only the owner holds: a
 * partner can prepare and submit a plan, but cannot commit the agency to it.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const resolved = await resolveRouteActor(request);
    if (!resolved) return routeUnauthenticated();
    requireCapability(resolved.actor, "projects.plan.approve");
    const { id } = await params;
    const parsed = approveSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) throw new ValidationError("Invalid request", { issues: parsed.error.issues.length });

    const result = await approvePlan(id, resolved.actor, { note: parsed.data.note ?? null });
    return Response.json(
      {
        data: {
          plan: {
            id: result.plan.id,
            version: result.plan.version,
            status: result.plan.status,
            approvedAt: result.plan.approved_at,
          },
          phases: result.phases,
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return routeErrorResponse(error, "projects-api");
  }
}
