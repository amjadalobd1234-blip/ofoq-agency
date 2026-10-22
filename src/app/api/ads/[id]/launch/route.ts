import { requireUser } from "@/lib/auth/permissions";
import { resolveRouteActor, routeErrorResponse, routeUnauthenticated } from "@/lib/auth/route-actor";
import { forbidLiveAdsExecution } from "@/lib/services/ad-plans.service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/ads/[id]/launch — always refused.
 *
 * The Ads Agent is advisory. There is no Meta / Google / TikTok connection
 * and the platform never launches, pauses or spends.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const resolved = await resolveRouteActor(request);
    if (!resolved) return routeUnauthenticated();
    requireUser(resolved.actor);
    await params;
    forbidLiveAdsExecution();
  } catch (error) {
    return routeErrorResponse(error, "ads-api");
  }
}
