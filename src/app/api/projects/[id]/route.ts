import { z } from "zod";

import { isStaff, requireCapability } from "@/lib/auth/permissions";
import { resolveRouteActor, routeErrorResponse, routeUnauthenticated } from "@/lib/auth/route-actor";
import { NotFoundError, ValidationError } from "@/lib/core/errors";
import {
  getClientProjectView,
  getStaffProjectView,
  updateProjectDetails,
} from "@/lib/services/projects.service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const patchSchema = z.object({
  title: z.string().trim().min(2).max(200).optional(),
  titleEn: z.string().trim().max(200).nullable().optional(),
  brief: z.string().trim().max(5000).nullable().optional(),
  dueDate: z.string().trim().min(1).nullable().optional(),
  riskLevel: z.enum(["LOW", "MEDIUM", "HIGH"]).nullable().optional(),
});

/**
 * GET /api/projects/[id] — one project.
 *
 * Staff get the full view (internal tasks, internal notes, plan, services).
 * The owning client gets the client-safe view: progress, the phases they are
 * allowed to see and their own tasks — nothing internal.
 *
 * PATCH /api/projects/[id] — the owner/partner edits the project details.
 * The status is NOT editable here: every status change is an explicit action.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const resolved = await resolveRouteActor(request);
    if (!resolved) return routeUnauthenticated();
    requireCapability(resolved.actor, "projects.view");
    const { id } = await params;

    if (isStaff(resolved.actor)) {
      const view = await getStaffProjectView(id);
      return Response.json({ data: view }, { headers: { "Cache-Control": "no-store" } });
    }

    if (!resolved.customer) throw new NotFoundError("Project not found");
    const view = await getClientProjectView(id, resolved.customer.id, resolved.customer.locale);
    return Response.json({ data: view }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return routeErrorResponse(error, "projects-api");
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const resolved = await resolveRouteActor(request);
    if (!resolved) return routeUnauthenticated();
    requireCapability(resolved.actor, "projects.manage");
    const { id } = await params;
    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new ValidationError("Invalid project edit", { issues: parsed.error.issues.length });

    const updated = await updateProjectDetails(id, parsed.data, resolved.actor.id);
    return Response.json(
      { data: { id: updated.id, code: updated.code, title: updated.title, dueDate: updated.due_date } },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return routeErrorResponse(error, "projects-api");
  }
}
