import { z } from "zod";

import { isStaff, requireCapability } from "@/lib/auth/permissions";
import { resolveRouteActor, routeErrorResponse, routeUnauthenticated } from "@/lib/auth/route-actor";
import { NotFoundError, ValidationError } from "@/lib/core/errors";
import { getClientAdPlan, getStaffAdPlan, saveAdPlanDraft } from "@/lib/services/ad-plans.service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const patchSchema = z.object({
  summary: z.string().trim().max(2000).nullable().optional(),
  brief: z.string().trim().max(4000).nullable().optional(),
  objective: z.enum(["AWARENESS", "TRAFFIC", "ENGAGEMENT", "MESSAGES", "LEADS", "SALES"]).optional(),
  audienceDescription: z.string().trim().max(2000).nullable().optional(),
  geo: z.array(z.string().trim().min(1).max(80)).max(12).optional(),
  durationDays: z.number().int().min(1).max(365).optional(),
  totalBudgetUsd: z.number().positive().optional(),
  platformPercents: z
    .array(z.object({ platform: z.enum(["META_ADS", "GOOGLE_ADS", "TIKTOK"]), percent: z.number().min(0).max(100) }))
    .max(3)
    .optional(),
  adCopy: z
    .array(
      z.object({
        platform: z.enum(["META_ADS", "GOOGLE_ADS", "TIKTOK"]),
        headline: z.string().trim().min(1).max(200),
        primaryText: z.string().trim().min(1).max(2000),
        cta: z.string().trim().min(1).max(80),
      }),
    )
    .max(6)
    .optional(),
  adIdeas: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(200),
        format: z.string().trim().min(1).max(80),
        description: z.string().trim().min(1).max(1000),
      }),
    )
    .max(8)
    .optional(),
  internalNote: z.string().trim().max(4000).nullable().optional(),
  reviewNote: z.string().trim().max(2000).nullable().optional(),
});

/**
 * GET   /api/ads/[id] — staff: full plan (including internal notes).
 *                       client: approved plan of their own, or 404.
 * PATCH /api/ads/[id] — staff: edit. An approved plan becomes a new DRAFT version.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const resolved = await resolveRouteActor(request);
    if (!resolved) return routeUnauthenticated();
    requireCapability(resolved.actor, "campaigns.view");
    const { id } = await params;

    if (isStaff(resolved.actor)) {
      const plan = await getStaffAdPlan(id, resolved.actor);
      return Response.json({ data: { plan } }, { headers: { "Cache-Control": "no-store" } });
    }

    const actor = { ...resolved.actor, customerId: resolved.customer?.id ?? resolved.actor.customerId };
    if (!actor.customerId) throw new NotFoundError("Ad plan not found");
    const plan = await getClientAdPlan(id, actor);
    return Response.json({ data: { plan } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return routeErrorResponse(error, "ads-api");
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const resolved = await resolveRouteActor(request);
    if (!resolved) return routeUnauthenticated();
    requireCapability(resolved.actor, "campaigns.manage");
    const { id } = await params;
    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new ValidationError("Invalid ads plan edit", { issues: parsed.error.issues.length });

    const plan = await saveAdPlanDraft(id, resolved.actor, parsed.data);
    return Response.json(
      { data: { plan, requiresOwnerApproval: true, liveExecution: false } },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return routeErrorResponse(error, "ads-api");
  }
}
