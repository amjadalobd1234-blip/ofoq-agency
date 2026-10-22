import { requireCapability } from "@/lib/auth/permissions";
import { resolveRouteActor, routeErrorResponse, routeUnauthenticated } from "@/lib/auth/route-actor";
import { monitorProjects } from "@/lib/services/projects.service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/projects/monitor — the owner's delivery watch.
 *
 * Checks the active projects and raises in-app alerts for overdue tasks and
 * for delivery dates that are close or already passed. No email is sent and
 * no project state is changed.
 */
export async function POST(request: Request) {
  try {
    const resolved = await resolveRouteActor(request);
    if (!resolved) return routeUnauthenticated();
    requireCapability(resolved.actor, "projects.manage");

    const summary = await monitorProjects(resolved.actor);
    return Response.json({ data: summary }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return routeErrorResponse(error, "projects-api");
  }
}
