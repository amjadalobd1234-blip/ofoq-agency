import { z } from "zod";

import { requireCapability } from "@/lib/auth/permissions";
import { resolveRouteActor, routeErrorResponse, routeUnauthenticated } from "@/lib/auth/route-actor";
import { ValidationError } from "@/lib/core/errors";
import {
  getPlanWithTasks,
  savePlanDraft,
} from "@/lib/services/project-plans.service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const taskSchema = z.object({
  title: z.string().trim().min(1).max(300),
  titleEn: z.string().trim().max(300).nullable().optional(),
  dueDate: z.string().trim().min(1).nullable().optional(),
  owner: z.string().trim().max(80).nullable().optional(),
  visibility: z.enum(["CLIENT", "INTERNAL"]).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
});

const phaseSchema = z.object({
  key: z.string().trim().min(1).max(60),
  title: z.string().trim().min(1).max(300),
  titleEn: z.string().trim().max(300).nullable().optional(),
  dueDate: z.string().trim().min(1).nullable().optional(),
  owner: z.string().trim().max(80).nullable().optional(),
  ownerLabel: z.string().trim().max(120).nullable().optional(),
  tasks: z.array(taskSchema).max(40).optional(),
});

const saveSchema = z.object({
  phases: z.array(phaseSchema).min(1).max(12),
  summary: z.string().trim().max(4000).nullable().optional(),
  startDate: z.string().trim().min(1).nullable().optional(),
  dueDate: z.string().trim().min(1).nullable().optional(),
  reviewNote: z.string().trim().max(2000).nullable().optional(),
});

/**
 * GET /api/projects/[id]/plan — the plan of a project (staff only).
 *
 * POST /api/projects/[id]/plan — save the plan draft: phases, tasks,
 * deadlines and responsibilities. Saving never commits anything: the plan
 * returns to `DRAFT` and waits for the owner's approval.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const resolved = await resolveRouteActor(request);
    if (!resolved) return routeUnauthenticated();
    requireCapability(resolved.actor, "projects.view");
    const { id } = await params;
    const plan = await getPlanWithTasks(id);
    return Response.json({ data: plan }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return routeErrorResponse(error, "projects-api");
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const resolved = await resolveRouteActor(request);
    if (!resolved) return routeUnauthenticated();
    requireCapability(resolved.actor, "projects.manage");
    const { id } = await params;
    const parsed = saveSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new ValidationError("Invalid plan", { issues: parsed.error.issues.length });

    const saved = await savePlanDraft(id, resolved.actor, parsed.data);
    return Response.json(
      {
        data: {
          plan: {
            id: saved.plan.id,
            version: saved.plan.version,
            status: saved.plan.status,
            summary: saved.plan.summary,
            dueDate: saved.plan.due_date,
          },
          phases: saved.phases,
          requiresOwnerApproval: true,
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return routeErrorResponse(error, "projects-api");
  }
}
