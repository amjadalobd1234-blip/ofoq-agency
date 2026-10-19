import { z } from "zod";

import { requireCapability } from "@/lib/auth/permissions";
import { resolveRouteActor, routeErrorResponse, routeUnauthenticated } from "@/lib/auth/route-actor";
import { ValidationError } from "@/lib/core/errors";
import { updateTaskWithNote } from "@/lib/services/projects.service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const patchSchema = z.object({
  status: z.enum(["TODO", "IN_PROGRESS", "BLOCKED", "REVIEW", "DONE"]).optional(),
  /** Internal note — stored on the task and never shown to the client. */
  note: z.string().trim().max(4000).nullable().optional(),
});

/**
 * PATCH /api/projects/[id]/tasks/[taskId] — the execution step.
 *
 * Staff update the status of a task and/or append an internal note. The
 * project progress is recomputed from the real tasks right away, so the number
 * the client sees always matches the work that was done.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; taskId: string }> },
) {
  try {
    const resolved = await resolveRouteActor(request);
    if (!resolved) return routeUnauthenticated();
    requireCapability(resolved.actor, "tasks.manage");
    const { id, taskId } = await params;
    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new ValidationError("Invalid task update", { issues: parsed.error.issues.length });
    if (parsed.data.status === undefined && !parsed.data.note) {
      throw new ValidationError("Nothing to update", { field: "status" });
    }

    const task = await updateTaskWithNote(taskId, parsed.data, resolved.actor, { projectId: id });
    return Response.json(
      {
        data: {
          id: task.id,
          status: task.status,
          dueDate: task.due_date,
          completedAt: task.completed_at,
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return routeErrorResponse(error, "projects-api");
  }
}
