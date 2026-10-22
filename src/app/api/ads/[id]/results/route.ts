import { z } from "zod";

import { requireCapability } from "@/lib/auth/permissions";
import { resolveRouteActor, routeErrorResponse, routeUnauthenticated } from "@/lib/auth/route-actor";
import { ValidationError } from "@/lib/core/errors";
import { recordAdPlanResult } from "@/lib/services/ad-plans.service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const resultSchema = z.object({
  date: z.string().trim().min(10).max(10),
  platform: z.enum(["META_ADS", "GOOGLE_ADS", "TIKTOK", "ALL"]).optional(),
  spendUsd: z.number().min(0).optional(),
  impressions: z.number().int().min(0).optional(),
  clicks: z.number().int().min(0).optional(),
  messages: z.number().int().min(0).optional(),
  orders: z.number().int().min(0).optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

/** POST /api/ads/[id]/results — staff types in real numbers. Nothing is fetched from an ads platform. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const resolved = await resolveRouteActor(request);
    if (!resolved) return routeUnauthenticated();
    requireCapability(resolved.actor, "campaigns.manage");
    const { id } = await params;
    const parsed = resultSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new ValidationError("Invalid results", { issues: parsed.error.issues.length });

    const recorded = await recordAdPlanResult(id, resolved.actor, parsed.data);
    return Response.json(
      { data: { result: recorded.result, actuals: recorded.actuals, source: "MANUAL", liveExecution: false } },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return routeErrorResponse(error, "ads-api");
  }
}
