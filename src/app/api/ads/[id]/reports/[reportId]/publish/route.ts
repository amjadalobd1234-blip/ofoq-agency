import { requireCapability } from "@/lib/auth/permissions";
import { resolveRouteActor, routeErrorResponse, routeUnauthenticated } from "@/lib/auth/route-actor";
import { publishAdPlanReport } from "@/lib/services/ad-plans.service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** POST /api/ads/[id]/reports/[reportId]/publish — show a draft report in the client portal. No email. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; reportId: string }> },
) {
  try {
    const resolved = await resolveRouteActor(request);
    if (!resolved) return routeUnauthenticated();
    requireCapability(resolved.actor, "campaigns.manage");
    const { id, reportId } = await params;
    const report = await publishAdPlanReport(id, reportId, resolved.actor);
    return Response.json(
      { data: { id: report.id, status: report.status, sentAt: report.sent_at, liveExecution: false } },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return routeErrorResponse(error, "ads-api");
  }
}
