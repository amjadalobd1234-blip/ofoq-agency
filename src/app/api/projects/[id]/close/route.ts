import { z } from "zod";

import { requireCapability } from "@/lib/auth/permissions";
import { resolveRouteActor, routeErrorResponse, routeUnauthenticated } from "@/lib/auth/route-actor";
import { ValidationError } from "@/lib/core/errors";
import { closeProject } from "@/lib/services/projects.service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const closeSchema = z.object({
  note: z.string().trim().max(2000).nullable().optional(),
});

/**
 * POST /api/projects/[id]/close — the owner's explicit closing decision.
 *
 * Nothing closes a project automatically: the route requires `projects.close`,
 * which only the owner holds, and every client-visible task must be done.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const resolved = await resolveRouteActor(request);
    if (!resolved) return routeUnauthenticated();
    requireCapability(resolved.actor, "projects.close");
    const { id } = await params;
    const parsed = closeSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) throw new ValidationError("Invalid request", { issues: parsed.error.issues.length });

    const project = await closeProject(id, resolved.actor, { note: parsed.data.note ?? null });
    return Response.json(
      {
        data: {
          id: project.id,
          code: project.code,
          status: project.status,
          progress: project.progress,
          completedAt: project.completed_at,
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return routeErrorResponse(error, "projects-api");
  }
}
