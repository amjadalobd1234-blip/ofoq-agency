import { daysBetween, formatDate } from "@/lib/core/date";
import type { CustomerRow, Locale, ProjectRow, ServiceRow } from "@/lib/domain/types";
import { findProjectById, listProjectTasks } from "@/lib/repositories/projects.repo";
import { saveAgentPlanProposal } from "@/lib/services/project-plans.service";

import { runAgent } from "../runtime";
import { buildPlanProposal } from "./projects.agent";

/**
 * Project manager agent — the delivery side of the Projects Agent.
 *
 * What it does:
 *   1. turns the services of a project into a deterministic plan proposal
 *      (phases → tasks → deadlines → responsibilities),
 *   2. stores that proposal as a DRAFT plan, ready for the owner's review.
 *
 * What it must never do (the rule of the whole platform):
 *   - approve its own plan — `projects.plan.approve` is owner-only,
 *   - change a sensitive project state (status, completion, a client promise),
 *   - create a task that counts as committed work before the owner approved
 *     the plan.
 *
 * The plan structure comes from the Projects Agent blueprint, so there is one
 * and only one plan system in the platform.
 */
export interface DeliveryPlanOutcome {
  project: ProjectRow;
  taskCount: number;
  dueDate: string | null;
  /** The draft plan that is waiting for the owner's approval. */
  planId: string;
  version: number;
  requiresOwnerApproval: true;
}

/**
 * Proposes a delivery plan for a project — a proposal, never a commitment.
 *
 * The project keeps its current status: only the owner's approval turns the
 * draft into a commitment (and moves the project to PLANNING).
 */
export async function proposeDeliveryPlan(input: {
  project: ProjectRow;
  customer: CustomerRow;
  services: ServiceRow[];
  profile: { platforms: string[]; volume: number | null; timelineDays: number | null };
  locale: Locale;
}): Promise<DeliveryPlanOutcome> {
  const proposal = buildPlanProposal({
    services: input.services,
    startDate: input.project.start_date,
    timelineDays: input.profile.timelineDays,
    locale: input.locale,
  });
  const taskCount = proposal.phases.reduce((total, phase) => total + (phase.tasks?.length ?? 0), 0);

  const saved = await saveAgentPlanProposal(
    input.project.id,
    {
      phases: proposal.phases,
      summary: proposal.summary,
      startDate: proposal.startDate,
      dueDate: proposal.dueDate,
      locale: input.locale,
    },
    { createdByAgent: "project_manager" },
  );

  await runAgent(
    "project_manager",
    {
      trigger: "offer.proposed",
      locale: input.locale,
      customerId: input.customer.id,
      projectId: input.project.id,
      input: { services: proposal.services, phases: proposal.phases.length, tasks: taskCount },
    },
    async ({ record }) => {
      record({
        action: "plan.proposed",
        summary: `اقترح وكيل إدارة المشاريع خطة من ${proposal.phases.length} مراحل و${taskCount} مهمة — بانتظار مراجعة المالك واعتمادها`,
        reason: `services:${proposal.services.join(",") || "none"}`,
        entityType: "project_plan",
        entityId: saved.plan.id,
        riskLevel: "LOW",
        requiresApproval: true,
        payload: { planId: saved.plan.id, version: saved.plan.version, tasks: taskCount },
      });
      return {
        data: { planId: saved.plan.id, version: saved.plan.version, tasks: taskCount },
        summary: `خطة مقترحة (${proposal.phases.length} مراحل، ${taskCount} مهمة) — بانتظار اعتماد المالك`,
        riskLevel: "LOW",
      };
    },
  );

  return {
    project: input.project,
    taskCount,
    dueDate: proposal.dueDate,
    planId: saved.plan.id,
    version: saved.plan.version,
    requiresOwnerApproval: true,
  };
}

/** Human-readable delivery status line for notifications and portal headers. */
export function describeProgress(project: ProjectRow, locale: Locale): string {
  const due = project.due_date ? formatDate(project.due_date, locale, "long") : null;
  if (locale === "ar") {
    return due
      ? `نسبة الإنجاز ${project.progress}% — التسليم المتوقع ${due}`
      : `نسبة الإنجاز ${project.progress}%`;
  }
  return due
    ? `Progress ${project.progress}% — expected delivery ${due}`
    : `Progress ${project.progress}%`;
}

/** The number of days left before the delivery date (null when there is none). */
export function daysUntilDelivery(project: ProjectRow): number | null {
  return project.due_date ? daysBetween(new Date(), project.due_date) : null;
}

/** The tasks of a project, for the delivery views. */
export async function projectTasks(projectId: string, includeInternal = true) {
  return listProjectTasks(projectId, { includeInternal });
}
