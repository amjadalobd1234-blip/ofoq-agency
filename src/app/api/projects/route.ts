import { z } from "zod";

import { isStaff, requireCapability } from "@/lib/auth/permissions";
import { resolveRouteActor, routeErrorResponse, routeUnauthenticated } from "@/lib/auth/route-actor";
import { ValidationError } from "@/lib/core/errors";
import { listProjectSummaries } from "@/lib/services/projects.service";
import { createManagedProject } from "@/lib/services/projects.service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const createSchema = z.object({
  customerId: z.string().trim().min(1),
  title: z.string().trim().min(2).max(200),
  /** Catalogue service slug — used when the project is not based on an offer. */
  serviceSlug: z.string().trim().min(1).optional(),
  /** An accepted (APPROVED) offer of the same customer. */
  offerId: z.string().trim().min(1).optional(),
  brief: z.string().trim().max(5000).optional(),
  startDate: z.string().trim().min(1).optional(),
  dueDate: z.string().trim().min(1).optional(),
});

/**
 * GET /api/projects — the projects list.
 *
 * Staff see every project with the plan state, the task counters and the
 * internal risk level. A client sees only their own projects, without any
 * internal field.
 *
 * POST /api/projects — the owner/partner creates a project for a customer,
 * from a catalogue service or from an offer the client has accepted. The
 * agent only *proposes* the plan: the owner approves it.
 */
export async function GET(request: Request) {
  try {
    const resolved = await resolveRouteActor(request);
    if (!resolved) return routeUnauthenticated();
    requireCapability(resolved.actor, "projects.view");

    const url = new URL(request.url);
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50));

    if (isStaff(resolved.actor)) {
      const rows = await listProjectSummaries({ limit });
      return Response.json({ data: { rows, total: rows.length } }, { headers: { "Cache-Control": "no-store" } });
    }

    if (!resolved.customer) {
      return Response.json({ data: { rows: [], total: 0 } }, { headers: { "Cache-Control": "no-store" } });
    }
    const rows = await listProjectSummaries({ customerId: resolved.customer.id, limit });
    const clientRows = rows.map((row) => ({
      id: row.id,
      code: row.code,
      title: row.title,
      titleEn: row.titleEn,
      status: row.status,
      progress: row.progress,
      dueDate: row.dueDate,
      daysRemaining: row.daysRemaining,
      // Only the approved plan: a draft is a proposal between the agency and
      // its owner, never something the client is shown.
      plan: row.approvedPlan
        ? { version: row.approvedPlan.version, status: row.approvedPlan.status, approvedAt: row.approvedPlan.approvedAt }
        : null,
      tasks: { total: row.tasks.total, done: row.tasks.done, open: row.tasks.open },
    }));
    return Response.json(
      { data: { rows: clientRows, total: clientRows.length } },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return routeErrorResponse(error, "projects-api");
  }
}

export async function POST(request: Request) {
  try {
    const resolved = await resolveRouteActor(request);
    if (!resolved) return routeUnauthenticated();
    requireCapability(resolved.actor, "projects.manage");

    const body = await request.json().catch(() => null);
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError("Invalid project request", { issues: parsed.error.issues.length });
    if (!parsed.data.offerId && !parsed.data.serviceSlug) {
      throw new ValidationError("A project needs either a service or an accepted offer", {
        field: "serviceSlug",
      });
    }

    const result = await createManagedProject({ ...parsed.data, actor: resolved.actor });
    return Response.json(
      {
        data: {
          project: {
            id: result.project.id,
            code: result.project.code,
            title: result.project.title,
            status: result.project.status,
            progress: result.project.progress,
            dueDate: result.project.due_date,
            customerId: result.project.customer_id,
          },
          plan: result.plan,
          requiresOwnerApproval: result.requiresOwnerApproval,
        },
      },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return routeErrorResponse(error, "projects-api");
  }
}
