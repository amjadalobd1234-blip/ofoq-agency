import { z } from "zod";

import { isStaff, requireCapability } from "@/lib/auth/permissions";
import { resolveRouteActor, routeErrorResponse, routeUnauthenticated } from "@/lib/auth/route-actor";
import { ValidationError } from "@/lib/core/errors";
import { createAdPlanForCustomer, listClientAdPlans, listStaffAdPlans } from "@/lib/services/ad-plans.service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const createSchema = z.object({
  customerId: z.string().trim().min(1),
  projectId: z.string().trim().min(1).nullable().optional(),
  businessCategory: z
    .enum([
      "LOCAL_RETAIL",
      "RESTAURANT",
      "SERVICES",
      "PROFESSIONAL",
      "ECOMMERCE",
      "CONTENT",
      "REAL_ESTATE",
      "EDUCATION",
      "HEALTH",
      "OTHER",
    ])
    .optional(),
  objective: z.enum(["AWARENESS", "TRAFFIC", "ENGAGEMENT", "MESSAGES", "LEADS", "SALES"]).optional(),
  brief: z.string().trim().max(4000).nullable().optional(),
  audience: z.string().trim().max(2000).nullable().optional(),
  geo: z.array(z.string().trim().min(1).max(80)).max(12).optional(),
  totalBudgetUsd: z.number().positive(),
  durationDays: z.number().int().min(1).max(365).optional(),
  preferredPlatforms: z.array(z.enum(["META_ADS", "GOOGLE_ADS", "TIKTOK"])).max(3).optional(),
  locale: z.enum(["ar", "en"]).optional(),
  internalNote: z.string().trim().max(4000).nullable().optional(),
});

/**
 * GET  /api/ads — staff: latest version of every family; client: approved plans only.
 * POST /api/ads — owner/partner: the Ads Agent writes a DRAFT. Nothing is launched.
 */
export async function GET(request: Request) {
  try {
    const resolved = await resolveRouteActor(request);
    if (!resolved) return routeUnauthenticated();
    requireCapability(resolved.actor, "campaigns.view");

    if (isStaff(resolved.actor)) {
      const url = new URL(request.url);
      const customerId = url.searchParams.get("customerId")?.trim() || undefined;
      const rows = await listStaffAdPlans(resolved.actor, customerId);
      return Response.json({ data: { rows, total: rows.length } }, { headers: { "Cache-Control": "no-store" } });
    }

    const rows = await listClientAdPlans({ ...resolved.actor, customerId: resolved.customer?.id ?? resolved.actor.customerId });
    return Response.json({ data: { rows, total: rows.length } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return routeErrorResponse(error, "ads-api");
  }
}

export async function POST(request: Request) {
  try {
    const resolved = await resolveRouteActor(request);
    if (!resolved) return routeUnauthenticated();
    requireCapability(resolved.actor, "campaigns.manage");

    const parsed = createSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new ValidationError("Invalid ads plan request", { issues: parsed.error.issues.length });

    const plan = await createAdPlanForCustomer(parsed.data, resolved.actor);
    return Response.json(
      { data: { plan, requiresOwnerApproval: true, liveExecution: false } },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return routeErrorResponse(error, "ads-api");
  }
}
