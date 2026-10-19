import { addDays, nowIso, toDateKey } from "@/lib/core/date";
import { NotFoundError, PreconditionError, ValidationError } from "@/lib/core/errors";
import { requireCapability, type Actor } from "@/lib/auth/permissions";
import type {
  Locale,
  ProjectPlanPhase,
  ProjectPlanRow,
  ProjectTaskRow,
  Visibility,
} from "@/lib/domain/types";
import {
  createProjectPlan,
  createProjectTask,
  deleteProjectTask,
  findLatestApprovedProjectPlan,
  findLatestProjectPlan,
  findProjectById,
  listClientVisibleTasks,
  listProjectPlans,
  listProjectTasks,
  nextPlanVersion,
  recomputeProgress,
  updateProject,
  updateProjectPlan,
  updateProjectTask,
} from "@/lib/repositories/projects.repo";

import { logActivity } from "./activity.service";

/**
 * Project plans (خطة المشروع) — the document the Projects Agent prepares and
 * the owner approves.
 *
 * Rules enforced here (not in the UI):
 *   1. A plan is a proposal until the owner approves it. Saving, editing or
 *      submitting never changes a sensitive project state on its own.
 *   2. Only the owner approves a plan (`projects.plan.approve`) — a partner can
 *      prepare and submit, but cannot commit the agency to a delivery date.
 *   3. Editing an approved plan returns it to `DRAFT`: the previous approval
 *      no longer covers the new content.
 *   4. Every change is written to the activity log, and the tasks themselves
 *      stay in the existing `project_tasks` table (no duplicated task store).
 */

export interface PlanTaskInput {
  title: string;
  titleEn?: string | null;
  dueDate?: string | null;
  /** Responsible role/agent key (e.g. `project_manager`, `content`). */
  owner?: string | null;
  visibility?: Visibility;
  description?: string | null;
}

export interface PlanPhaseInput {
  key: string;
  title: string;
  titleEn?: string | null;
  dueDate?: string | null;
  owner?: string | null;
  ownerLabel?: string | null;
  tasks?: PlanTaskInput[];
}

export interface SavePlanInput {
  phases: PlanPhaseInput[];
  summary?: string | null;
  startDate?: string | null;
  dueDate?: string | null;
  reviewNote?: string | null;
  locale?: Locale;
}

export interface PlanWithTasks {
  plan: ProjectPlanRow;
  phases: ProjectPlanPhase[];
  tasks: ProjectTaskRow[];
}

const MAX_PHASES = 12;
const MAX_TASKS_PER_PHASE = 40;

function assertValidDate(value: string | null | undefined, field: string): void {
  if (value === null || value === undefined || value === "") return;
  if (Number.isNaN(new Date(value).getTime())) {
    throw new ValidationError(`Invalid date for ${field}`, { field });
  }
}

function normalisePhases(phases: PlanPhaseInput[]): ProjectPlanPhase[] {
  if (!Array.isArray(phases) || phases.length === 0) {
    throw new ValidationError("A plan needs at least one phase", { field: "phases" });
  }
  if (phases.length > MAX_PHASES) {
    throw new ValidationError(`A plan cannot have more than ${MAX_PHASES} phases`, { field: "phases" });
  }
  const seen = new Set<string>();
  return phases.map((phase, index) => {
    const key = (phase.key ?? "").trim() || `PHASE_${index + 1}`;
    if (seen.has(key)) {
      throw new ValidationError(`Duplicate phase key: ${key}`, { field: "phases" });
    }
    seen.add(key);
    if (!phase.title || !phase.title.trim()) {
      throw new ValidationError(`Phase ${key} needs a title`, { field: "phases" });
    }
    assertValidDate(phase.dueDate, `phases[${index}].dueDate`);
    const tasks = phase.tasks ?? [];
    if (tasks.length > MAX_TASKS_PER_PHASE) {
      throw new ValidationError(
        `Phase ${key} cannot have more than ${MAX_TASKS_PER_PHASE} tasks`,
        { field: "phases" },
      );
    }
    for (const task of tasks) {
      if (!task.title || !task.title.trim()) {
        throw new ValidationError(`Phase ${key} has a task without a title`, { field: "phases" });
      }
      assertValidDate(task.dueDate, `phases[${index}].tasks.dueDate`);
    }
    return {
      key,
      title: phase.title.trim(),
      titleEn: phase.titleEn?.trim() || null,
      dueDate: phase.dueDate ?? null,
      owner: phase.owner ?? null,
      ownerLabel: phase.ownerLabel ?? null,
      tasks: tasks.map((task) => ({
        title: task.title.trim(),
        titleEn: task.titleEn?.trim() || null,
        dueDate: task.dueDate ?? null,
        owner: task.owner ?? null,
        visibility: task.visibility ?? "CLIENT",
      })),
    };
  });
}

/** Reads the phase structure stored on the plan row. */
export function parsePlanPhases(plan: ProjectPlanRow | undefined): ProjectPlanPhase[] {
  if (!plan?.phases) return [];
  try {
    const parsed = JSON.parse(plan.phases) as ProjectPlanPhase[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function getProjectPlan(projectId: string): Promise<ProjectPlanRow | undefined> {
  return findLatestProjectPlan(projectId);
}

export async function listProjectPlanVersions(projectId: string): Promise<ProjectPlanRow[]> {
  return listProjectPlans(projectId);
}

export async function getPlanWithTasks(projectId: string): Promise<PlanWithTasks | null> {
  const plan = await findLatestProjectPlan(projectId);
  if (!plan) return null;
  const tasks = await listProjectTasks(projectId, { includeInternal: true });
  return { plan, phases: parsePlanPhases(plan), tasks };
}

/**
 * The newest APPROVED plan of a project — what the client is allowed to see.
 *
 * A draft revision does not replace it: the client keeps seeing the plan the
 * owner actually approved until the next version is approved too.
 */
export async function getApprovedPlanWithTasks(projectId: string): Promise<PlanWithTasks | null> {
  const plan = await findLatestApprovedProjectPlan(projectId);
  if (!plan) return null;
  const tasks = await listClientVisibleTasks(projectId);
  return { plan, phases: parsePlanPhases(plan), tasks };
}

/**
 * Saves the plan draft of a project.
 *
 * The first save creates version 1; saving again edits the draft in place. When
 * the current plan is already approved, a NEW version is created and the
 * approved one is kept as `SUPERSEDED` for the audit trail.
 */
export async function savePlanDraft(
  projectId: string,
  actor: Actor,
  input: SavePlanInput,
  options: { createdByAgent?: string | null } = {},
): Promise<PlanWithTasks> {
  requireCapability(actor, "projects.manage");
  return persistPlanDraft(projectId, actor.id, input, options);
}

/**
 * The agent's own path: a proposal, never a commitment.
 *
 * The agent may prepare a plan draft, but it can never approve it and it
 * never changes a project state: the plan stays DRAFT and the owner decides.
 * This entry point is called from the agent code only — the HTTP routes always
 * go through `savePlanDraft`, which checks the staff capability.
 */
export async function saveAgentPlanProposal(
  projectId: string,
  input: SavePlanInput,
  options: { createdByAgent: string },
): Promise<PlanWithTasks> {
  return persistPlanDraft(projectId, null, input, options);
}

async function persistPlanDraft(
  projectId: string,
  actorUserId: string | null,
  input: SavePlanInput,
  options: { createdByAgent?: string | null } = {},
): Promise<PlanWithTasks> {
  const project = await findProjectById(projectId);
  if (!project) throw new NotFoundError("Project not found");
  if (project.status === "COMPLETED" || project.status === "CANCELLED") {
    throw new PreconditionError("A finished project cannot be replanned");
  }

  const phases = normalisePhases(input.phases);
  const locale: Locale = input.locale ?? project.customer_locale ?? "ar";
  const current = await findLatestProjectPlan(projectId);

  let plan: ProjectPlanRow;
  if (current && current.status !== "APPROVED" && current.status !== "SUPERSEDED") {
    plan = (await updateProjectPlan(current.id, {
      phases: JSON.stringify(phases),
      summary: input.summary ?? current.summary,
      start_date: input.startDate ?? current.start_date,
      due_date: input.dueDate ?? current.due_date,
      review_note: input.reviewNote ?? current.review_note,
      locale,
      // An edit always needs a fresh owner decision.
      status: "DRAFT",
      approved_by_user_id: null,
      approved_at: null,
    }))!;
  } else {
    // The current plan is approved: a NEW draft version is prepared and the
    // approved one stays in place — the client keeps the plan the owner
    // actually signed until the new version is approved too.
    plan = await createProjectPlan({
      project_id: projectId,
      version: await nextPlanVersion(projectId),
      status: "DRAFT",
      locale,
      summary: input.summary ?? null,
      phases: JSON.stringify(phases),
      start_date: input.startDate ?? null,
      due_date: input.dueDate ?? null,
      created_by_user_id: actorUserId,
      created_by_agent: options.createdByAgent ?? null,
      review_note: input.reviewNote ?? null,
    });
  }

  await syncPlanTasks(projectId, phases);

  if (input.dueDate && !project.due_date) {
    await updateProject(projectId, { due_date: input.dueDate });
  }

  await recomputeProgress(projectId);

  await logActivity({
    actor_type: options.createdByAgent ? "AGENT" : "USER",
    actor_user_id: options.createdByAgent ? null : actorUserId,
    actor_label: options.createdByAgent ?? null,
    action: "project.plan_saved",
    entity_type: "project_plan",
    entity_id: plan.id,
    customer_id: project.customer_id,
    project_id: projectId,
    summary: `خطة المشروع ${project.code} — نسخة ${plan.version} (${phases.length} مرحلة)`,
    meta: { version: plan.version, phases: phases.length, status: plan.status },
  });

  const tasks = await listProjectTasks(projectId, { includeInternal: true });
  return { plan, phases, tasks };
}

/**
 * Mirrors the plan structure onto the existing task table.
 *
 * A task that already exists (same title inside the same phase) is updated in
 * place so its status/notes survive an edit. A task that the owner removed from
 * the plan is deleted only while nothing happened on it yet; a task with
 * progress is kept so the audit trail stays complete.
 */
async function syncPlanTasks(projectId: string, phases: ProjectPlanPhase[]): Promise<void> {
  const existing = await listProjectTasks(projectId, { includeInternal: true });
  const byKey = new Map<string, ProjectTaskRow[]>();
  for (const task of existing) {
    const key = task.phase_key ?? "";
    const list = byKey.get(key) ?? [];
    list.push(task);
    byKey.set(key, list);
  }

  const used = new Set<string>();
  let order = 0;
  for (const phase of phases) {
    const phaseTasks = byKey.get(phase.key) ?? [];
    for (const input of phase.tasks ?? []) {
      const match = phaseTasks.find(
        (task) => !used.has(task.id) && task.title.trim() === input.title.trim(),
      );
      if (match) {
        used.add(match.id);
        await updateProjectTask(match.id, {
          title: input.title,
          title_en: input.titleEn ?? match.title_en,
          due_date: input.dueDate ?? null,
          assigned_agent: input.owner ?? match.assigned_agent,
          visibility: input.visibility ?? match.visibility,
          phase_key: phase.key,
          sort_order: order,
        });
      } else {
        await createProjectTask({
          project_id: projectId,
          title: input.title,
          title_en: input.titleEn ?? null,
          due_date: input.dueDate ?? null,
          assigned_agent: input.owner ?? null,
          visibility: input.visibility ?? "CLIENT",
          phase_key: phase.key,
          sort_order: order,
          status: "TODO",
        });
      }
      order += 1;
    }
  }

  for (const task of existing) {
    if (used.has(task.id)) continue;
    if (task.status === "TODO" && !task.internal_note) {
      await deleteProjectTask(task.id);
      continue;
    }
    // Work already happened on it: keep it in the project history.
    await updateProjectTask(task.id, { phase_key: task.phase_key ?? null });
  }
}

/**
 * Sends the draft to the owner for approval.
 *
 * The plan stays a proposal: the project keeps its current status until the
 * owner approves. The owner is notified inside the app only — no email is sent.
 */
export async function submitPlanForApproval(
  projectId: string,
  actor: Actor,
  options: { note?: string | null } = {},
): Promise<ProjectPlanRow> {
  requireCapability(actor, "projects.manage");
  const project = await findProjectById(projectId);
  if (!project) throw new NotFoundError("Project not found");
  const plan = await findLatestProjectPlan(projectId);
  if (!plan) throw new PreconditionError("This project has no plan yet");
  if (plan.status === "APPROVED") {
    throw new PreconditionError("This plan is already approved");
  }
  const phases = parsePlanPhases(plan);
  const taskCount = phases.reduce((total, phase) => total + (phase.tasks?.length ?? 0), 0);
  if (taskCount === 0) {
    throw new PreconditionError("A plan without tasks cannot be submitted");
  }

  const updated = (await updateProjectPlan(plan.id, {
    status: "AWAITING_APPROVAL",
    review_note: options.note ?? plan.review_note,
  }))!;

  const { raiseAlert } = await import("./alerts.service");
  await raiseAlert({
    severity: "IMPORTANT",
    category: "delivery",
    title_ar: `خطة مشروع بانتظار موافقتك: ${project.code}`,
    title_en: `Project plan awaiting your approval: ${project.code}`,
    body_ar: `خطة المشروع ${project.code} (نسخة ${plan.version}) جاهزة للمراجعة: ${phases.length} مرحلة و${taskCount} مهمة. لا تبدأ أي التزام قبل موافقتك.`,
    body_en: `The plan for ${project.code} (version ${plan.version}) is ready for review: ${phases.length} phases and ${taskCount} tasks. Nothing is committed before your approval.`,
    entity_type: "project",
    entity_id: projectId,
    customer_id: project.customer_id,
    target_role: "OWNER",
    dedupe_key: `project-plan-awaiting-approval:${plan.id}`,
    notify: false,
    meta: { projectId, planId: plan.id, version: plan.version, phases: phases.length, tasks: taskCount },
  });

  await logActivity({
    actor_type: "USER",
    actor_user_id: actor.id,
    action: "project.plan_submitted",
    entity_type: "project_plan",
    entity_id: plan.id,
    customer_id: project.customer_id,
    project_id: projectId,
    summary: `خطة المشروع ${project.code} أُرسلت لموافقة المالك`,
    meta: { version: plan.version, note: options.note ?? null },
  });

  return updated;
}

/**
 * The owner's explicit approval of a plan.
 *
 * Only the owner holds `projects.plan.approve`. This is the moment the plan
 * becomes a commitment: the project moves to PLANNING and the client is told
 * inside the app (never by email).
 */
export async function approvePlan(
  projectId: string,
  actor: Actor,
  options: { note?: string | null } = {},
): Promise<PlanWithTasks> {
  requireCapability(actor, "projects.plan.approve");
  const project = await findProjectById(projectId);
  if (!project) throw new NotFoundError("Project not found");
  const plan = await findLatestProjectPlan(projectId);
  if (!plan) throw new PreconditionError("This project has no plan yet");
  if (plan.status === "APPROVED") {
    throw new PreconditionError("This plan is already approved");
  }
  if (project.status === "COMPLETED" || project.status === "CANCELLED") {
    throw new PreconditionError("A finished project cannot be replanned");
  }

  const updated = (await updateProjectPlan(plan.id, {
    status: "APPROVED",
    approved_by_user_id: actor.id,
    approved_at: nowIso(),
    review_note: options.note ?? plan.review_note,
  }))!;

  // The approval belongs to this version: the older approved versions become
  // historical, and the client sees the newest approved one.
  const versions = await listProjectPlans(projectId);
  for (const version of versions) {
    if (version.id === updated.id) continue;
    if (version.status === "APPROVED") {
      await updateProjectPlan(version.id, { status: "SUPERSEDED" });
    }
  }

  const patch: Parameters<typeof updateProject>[1] = { status: "PLANNING" };
  if (plan.start_date) patch.start_date = plan.start_date;
  else if (!project.start_date) patch.start_date = nowIso();
  if (plan.due_date) patch.due_date = plan.due_date;
  await updateProject(projectId, patch);

  await notifyClientOfApprovedPlan(project.customer_id, project.code, plan.version, project.customer_locale ?? "ar");

  await logActivity({
    actor_type: "USER",
    actor_user_id: actor.id,
    action: "project.plan_approved",
    entity_type: "project_plan",
    entity_id: plan.id,
    customer_id: project.customer_id,
    project_id: projectId,
    summary: `اعتمد المالك خطة المشروع ${project.code} (نسخة ${plan.version})`,
    meta: { version: plan.version, note: options.note ?? null },
  });

  const tasks = await listProjectTasks(projectId, { includeInternal: true });
  return { plan: updated, phases: parsePlanPhases(updated), tasks };
}

async function notifyClientOfApprovedPlan(
  customerId: string,
  projectCode: string,
  version: number,
  locale: Locale,
): Promise<void> {
  try {
    const { findCustomerById } = await import("@/lib/repositories/customers.repo");
    const { createNotification } = await import("@/lib/repositories/messaging.repo");
    const customer = await findCustomerById(customerId);
    if (!customer?.user_id) return;
    await createNotification({
      user_id: customer.user_id,
      channel: "IN_APP",
      subject:
        locale === "ar"
          ? `اعتُمدت خطة مشروع ${projectCode}`
          : `The plan for project ${projectCode} was approved`,
      body:
        locale === "ar"
          ? `أصبحت خطة المشروع ${projectCode} معتمدة (نسخة ${version}). يمكنك متابعة المراحل والمهام من بوابتك.`
          : `The plan for project ${projectCode} is approved (version ${version}). You can follow its phases and tasks in your portal.`,
      status: "QUEUED",
    });
  } catch {
    // A missing notification must never fail the owner's approval.
  }
}

/**
 * The client-safe view of a plan.
 *
 * Only phases that contain at least one client-visible task are returned, the
 * responsible role stays internal, and no internal note is ever included.
 */
export function toClientPhases(
  phases: ProjectPlanPhase[],
  tasks: ProjectTaskRow[],
): { key: string; title: string; titleEn: string | null; dueDate: string | null; tasks: { title: string; status: string; dueDate: string | null }[] }[] {
  const byPhase = new Map<string, ProjectTaskRow[]>();
  for (const task of tasks) {
    if (task.visibility !== "CLIENT") continue;
    const key = task.phase_key ?? "";
    const list = byPhase.get(key) ?? [];
    list.push(task);
    byPhase.set(key, list);
  }

  const output: ReturnType<typeof toClientPhases> = [];
  for (const phase of phases) {
    const phaseTasks = byPhase.get(phase.key) ?? [];
    if (phaseTasks.length === 0) continue;
    output.push({
      key: phase.key,
      title: phase.title,
      titleEn: phase.titleEn ?? null,
      dueDate: phase.dueDate ?? null,
      tasks: phaseTasks.map((task) => ({
        title: task.title,
        status: task.status,
        dueDate: task.due_date,
      })),
    });
  }
  return output;
}

/** Default deadline of a plan phase, used when the owner does not set one. */
export function defaultPhaseDueDate(startDate: string | null | undefined, offsetDays: number): string {
  const base = startDate ? new Date(startDate) : new Date();
  return toDateKey(addDays(base, offsetDays));
}
