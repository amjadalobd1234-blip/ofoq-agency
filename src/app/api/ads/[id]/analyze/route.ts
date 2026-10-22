import { requireCapability } from "@/lib/auth/permissions";
import { resolveRouteActor, routeErrorResponse, routeUnauthenticated } from "@/lib/auth/route-actor";
import { analyzeAdPlan } from "@/lib/services/ad-plans.service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/ads/[id]/analyze — compute KPIs from manual results and suggest
 * improvements. The approved plan is never mutated. A new DRAFT may be opened.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const resolved = await resolveRouteActor(request);
    if (!resolved) return routeUnauthenticated();
    requireCapability(resolved.actor, "campaigns.manage");
    const { id } = await params;
    const analysis = await analyzeAdPlan(id, resolved.actor);
    return Response.json(
      {
        data: {
          actuals: analysis.actuals,
          recommendations: analysis.recommendations,
          report: {
            id: analysis.report.id,
            title: analysis.report.title,
            summary: analysis.report.summary,
            status: analysis.report.status,
          },
          suggestionDraftId: analysis.suggestionDraftId,
          approvedPlanUnchanged: true,
          liveExecution: false,
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return routeErrorResponse(error, "ads-api");
  }
}
