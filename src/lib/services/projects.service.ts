import { addDays, daysBetween, nowIso, toDateKey } from "@/lib/core/date";
import { NotFoundError, PreconditionError, ValidationError } from "@/lib/core/errors";
import { formatReference, nextSequence } from "@/lib/core/ids";
import { marginPct } from "@/lib/core/money";
import { requireCapability, type Actor } from "@/lib/auth/permissions";
import type {
  CustomerRow,
  Locale,
  ProjectRow,
  ProjectStatus,
  ProjectPlanRow,
  ProjectTaskRow,
  ProjectWithCustomer,
  ServiceRow,
  TaskStatus,
} from "@/lib/domain/types";
import {
  addProjectService,
  createProject,
  createProjectTask,
  findProjectByCode,
  findProjectById,
  findProjectTask,
  listOverdueProjects,
  listOverdueTasks,
  listProjectCodes,
  listClientVisibleTasks,
  listProjectPlansForProjects,
  listProjectServices,
  listProjectTasks,
  listProjects,
  listTasksForProjects,
  recomputeProgress,
  updateProject,
  updateProjectTask,
} from "@/lib/repositories/projects.repo";

import { logActivity } from "./activity.service";
import { alertProjectLate } from "./alerts.service";

/**
 * Project lifecycle.
 *
 * Statuses mirror the workflow required by the business rules, from "new
 * request" through to "completed"/"cancelled". Client-visible progress is
 * derived from CLIENT-visible tasks only; internal tasks never leak.
 */
export const PROJECT_STATUS_ORDER: ProjectStatus[] = [
  "DRAFT",
  "AWAITING_APPROVAL",
  "AWAITING_PAYMENT",
  "PLANNING",
  "IN_PROGRESS",
  "IN_REVIEW",
  "REVISIONS",
  "COMPLETED",
  "CANCELLED",
];

export interface CreateProjectInput {
  customer: CustomerRow;
  title: string;
  titleEn?: string | null;
  brief?: string | null;
  currency?: string;
  startDate?: string | null;
  dueDate?: string | null;
  createdByUserId?: string | null;
  createdByAgent?: string | null;
  status?: ProjectStatus;
}

export async function createProjectForCustomer(input: CreateProjectInput): Promise<ProjectRow> {
  const codes = await listProjectCodes();
  const code = formatReference("P", nextSequence(codes, "P"));
  const project = await createProject({
    customer_id: input.customer.id,
    title: input.title,
    title_en: input.titleEn ?? null,
    brief: input.brief ?? null,
    code,
    status: input.status ?? "DRAFT",
    currency: input.currency ?? input.customer.currency,
    country: input.customer.country,
    start_date: input.startDate ?? nowIso(),
    due_date: input.dueDate ?? null,
    created_by_user_id: input.createdByUserId ?? null,
    created_by_agent: input.createdByAgent ?? null,
    risk_level: "LOW",
  });

  await logActivity({
    actor_type: input.createdByUserId ? "USER" : input.createdByAgent ? "AGENT" : "SYSTEM",
    actor_user_id: input.createdByUserId ?? null,
    actor_label: input.createdByAgent ?? null,
    action: "project.created",
    entity_type: "project",
    entity_id: project.id,
    customer_id: input.customer.id,
    summary: `Project ${project.code} created for ${input.customer.contact_name}`,
  });

  return project;
}

export async function attachServicesToProject(
  projectId: string,
  lines: { service: ServiceRow; quantity: number; unitPriceMinor: number; months?: number | null }[],
): Promise<void> {
  for (const line of lines) {
    await addProjectService({
      project_id: projectId,
      service_id: line.service.id,
      name_snapshot: line.service.name_ar,
      quantity: line.quantity,
      unit_price_minor: line.unitPriceMinor,
      billing_type: line.service.billing_type,
      months: line.months ?? null,
    });
  }
}

/** Updates the project's money fields from a confirmed offer. */
export async function applyOfferFinancials(
  projectId: string,
  data: { totalMinor: number; internalCostMinor: number; currency: string },
): Promise<void> {
  await updateProject(projectId, {
    amount_total_minor: data.totalMinor,
    internal_cost_minor: data.internalCostMinor,
    margin_pct: marginPct(data.totalMinor, data.internalCostMinor),
    currency: data.currency,
  });
}

export async function changeStatus(
  projectId: string,
  status: ProjectStatus,
  actor: { userId?: string | null; agentKey?: string | null; note?: string },
): Promise<ProjectRow> {
  const project = await findProjectById(projectId);
  if (!project) throw new NotFoundError("Project not found");

  const patch: Partial<ProjectRow> = { status };
  if (status === "COMPLETED") {
    patch.completed_at = nowIso();
    patch.progress = 100;
  }
  if (status === "IN_PROGRESS" && !project.start_date) patch.start_date = nowIso();

  const updated = await updateProject(projectId, patch);

  await logActivity({
    actor_type: actor.userId ? "USER" : actor.agentKey ? "AGENT" : "SYSTEM",
    actor_user_id: actor.userId ?? null,
    actor_label: actor.agentKey ?? null,
    action: "project.status_changed",
    entity_type: "project",
    entity_id: projectId,
    customer_id: project.customer_id,
    summary: `${project.code}: ${project.status} → ${status}`,
    meta: { from: project.status, to: status, note: actor.note },
  });

  if (status === "COMPLETED") {
    await maybeRequestReview(projectId, project.customer_id);
  }

  return updated!;
}

async function maybeRequestReview(projectId: string, customerId: string): Promise<void> {
  const { createNotification, ensureWebConversation, createMessage } = await import(
    "@/lib/repositories/messaging.repo"
  );
  const { findCustomerById } = await import("@/lib/repositories/customers.repo");
  const customer = await findCustomerById(customerId);
  const locale: Locale = customer?.locale ?? "ar";
  const body =
    locale === "ar"
      ? "أنجزنا مشروعك بنجاح 🎉 هل يمكنك تقييم تجربتك بسرعة؟ تقييمك يساعدنا على التحسين."
      : "We have completed your project 🎉 Could you take a moment to rate your experience?";
  if (customer?.user_id) {
    await createNotification({
      user_id: customer.user_id,
      channel: "IN_APP",
      subject: locale === "ar" ? "قيّم تجربتك مع أفق" : "Rate your experience with Ofoq",
      body,
      status: "QUEUED",
    });
  }
  if (customer) {
    const conversation = await ensureWebConversation(customer.id);
    await createMessage({
      conversation_id: conversation.id,
      sender_type: "AGENT",
      sender_label: "satisfaction",
      body,
      language: locale,
      meta: { kind: "review_request", projectId },
    });
  }
}

/**
 * Client-facing project view: status, progress, milestones and pending items.
 *
 * This shape is deliberately narrow: the internal cost, the margin, the risk
 * level, the internal notes and the internal tasks of the project never leave
 * the agency through it.
 */
export interface ClientProjectView {
  project: {
    id: string;
    code: string;
    title: string;
    titleEn: string | null;
    brief: string | null;
    status: ProjectStatus;
    progress: number;
    currency: string;
    startDate: string | null;
    dueDate: string | null;
    completedAt: string | null;
  };
  tasks: {
    id: string;
    title: string;
    titleEn: string | null;
    status: TaskStatus;
    dueDate: string | null;
    completedAt: string | null;
    phaseKey: string | null;
  }[];
  services: { name: string; quantity: number; billingType: string; months: number | null }[];
  milestones: { label: string; done: boolean }[];
  daysRemaining: number | null;
  /** The approved plan, with the phases the client is allowed to see. */
  plan: {
    version: number;
    status: string;
    approvedAt: string | null;
    summary: string | null;
    phases: {
      key: string;
      title: string;
      titleEn: string | null;
      dueDate: string | null;
      tasks: { title: string; status: string; dueDate: string | null }[];
    }[];
  } | null;
}

export async function getClientProjectView(
  projectId: string,
  customerId: string,
  locale: Locale,
): Promise<ClientProjectView> {
  const project = await findProjectById(projectId);
  if (!project) throw new NotFoundError("Project not found");
  if (project.customer_id !== customerId) {
    // Same message as "not found" so ids cannot be probed.
    throw new NotFoundError("Project not found");
  }

  // Only committed work is visible: the tasks of a plan the owner has not
  // approved yet stay internal, and the plan shown is the approved version.
  const tasks = await listClientVisibleTasks(projectId);
  const services = await listProjectServices(projectId);
  const progress = await recomputeProgress(projectId);
  const refreshed = await findProjectById(projectId);
  const { getApprovedPlanWithTasks, toClientPhases } = await import("./project-plans.service");
  const planData = await getApprovedPlanWithTasks(projectId);

  return {
    project: {
      id: project.id,
      code: project.code,
      title: project.title,
      titleEn: project.title_en,
      brief: project.brief,
      status: (refreshed ?? project).status,
      progress,
      currency: project.currency,
      startDate: project.start_date,
      dueDate: project.due_date,
      completedAt: project.completed_at,
    },
    tasks: tasks.map((task) => ({
      id: task.id,
      title: task.title,
      titleEn: task.title_en,
      status: task.status,
      dueDate: task.due_date,
      completedAt: task.completed_at,
      phaseKey: task.phase_key,
    })),
    services: services.map((row) => ({
      name: row.name_snapshot,
      quantity: row.quantity,
      billingType: row.billing_type,
      months: row.months,
    })),
    milestones: buildMilestones(refreshed?.status ?? project.status, locale),
    daysRemaining: project.due_date ? daysBetween(new Date(), project.due_date) : null,
    plan: planData
      ? {
          version: planData.plan.version,
          status: planData.plan.status,
          approvedAt: planData.plan.approved_at,
          summary: planData.plan.summary,
          phases: toClientPhases(planData.phases, planData.tasks),
        }
      : null,
  };
}

export function buildMilestones(status: ProjectStatus, locale: Locale): { label: string; done: boolean }[] {
  const labels: Record<string, { ar: string; en: string }> = {
    AWAITING_APPROVAL: { ar: "بانتظار موافقتك على العرض", en: "Waiting for your offer approval" },
    AWAITING_PAYMENT: { ar: "بانتظار الدفع", en: "Waiting for payment" },
    PLANNING: { ar: "التخطيط وإعداد الخطة", en: "Planning" },
    IN_PROGRESS: { ar: "التنفيذ جارٍ", en: "In progress" },
    IN_REVIEW: { ar: "بانتظار مراجعتك", en: "Waiting for your review" },
    REVISIONS: { ar: "تعديلات مطلوبة", en: "Revisions in progress" },
    COMPLETED: { ar: "مكتمل", en: "Completed" },
  };

  const order: ProjectStatus[] = [
    "AWAITING_APPROVAL",
    "AWAITING_PAYMENT",
    "PLANNING",
    "IN_PROGRESS",
    "IN_REVIEW",
    "COMPLETED",
  ];
  const currentIndex = order.indexOf(status);

  return order
    .filter((entry) => labels[entry])
    .map((entry) => ({
      label: locale === "ar" ? labels[entry]!.ar : labels[entry]!.en,
      done: currentIndex === -1 ? status === "COMPLETED" : order.indexOf(entry) <= currentIndex,
    }));
}

/* ------------------------------------------------------------------- tasks --- */

export interface TaskTemplate {
  titleAr: string;
  titleEn: string;
  visibility?: "CLIENT" | "INTERNAL";
  offsetDays?: number;
  role?: "project_manager" | "content" | "ads_manager" | "seo" | "reporting";
}

export async function addTasks(
  projectId: string,
  templates: TaskTemplate[],
  locale: Locale,
): Promise<ProjectTaskRow[]> {
  const created: ProjectTaskRow[] = [];
  let order = 0;
  for (const template of templates) {
    const task = await createProjectTask({
      project_id: projectId,
      title: locale === "ar" ? template.titleAr : template.titleEn,
      title_en: template.titleEn,
      visibility: template.visibility ?? "CLIENT",
      sort_order: order,
      due_date: template.offsetDays ? toDateKey(addDays(new Date(), template.offsetDays)) : null,
      assigned_agent: template.role ?? null,
      status: "TODO",
    });
    order += 1;
    created.push(task);
  }
  await recomputeProgress(projectId);
  return created;
}

export async function setTaskStatus(
  taskId: string,
  status: TaskStatus,
  actor: { userId?: string | null; agentKey?: string | null },
): Promise<ProjectTaskRow> {
  const task = await updateProjectTask(taskId, {
    status,
    completed_at: status === "DONE" ? nowIso() : null,
  });
  if (!task) throw new NotFoundError("Task not found");

  await recomputeProgress(task.project_id);

  await logActivity({
    actor_type: actor.userId ? "USER" : actor.agentKey ? "AGENT" : "SYSTEM",
    actor_user_id: actor.userId ?? null,
    actor_label: actor.agentKey ?? null,
    action: "task.status_changed",
    entity_type: "project_task",
    entity_id: taskId,
    summary: `${task.title}: ${status}`,
    meta: { status },
  });

  const project = await findProjectById(task.project_id);
  if (project?.status === "PLANNING" && status === "IN_PROGRESS") {
    await changeStatus(project.id, "IN_PROGRESS", { userId: actor.userId, agentKey: actor.agentKey });
  }
  return task;
}

/* --------------------------------------------------------------- monitoring -- */

/** Raises alerts for late projects; called by the daily job and dashboards. */
export async function detectLateProjects(): Promise<number> {
  const projects = await listOverdueProjects(50);
  let raised = 0;
  for (const project of projects) {
    const daysLate = Math.max(1, Math.abs(daysBetween(new Date(), project.due_date!)));
    if (daysLate < 1) continue;
    await alertProjectLate({
      projectId: project.id,
      projectCode: project.code,
      customerId: project.customer_id,
      dueDate: project.due_date!,
      daysLate,
    });
    raised += 1;
  }
  return raised;
}

export async function listCustomerProjects(
  customerId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<{ rows: ProjectWithCustomer[]; total: number }> {
  return listProjects({ customerId, ...options });
}

export async function getProjectByCode(code: string): Promise<ProjectRow | undefined> {
  return findProjectByCode(code);
}

export async function updateProjectDetails(
  projectId: string,
  data: Partial<Pick<ProjectRow, "title" | "title_en" | "brief" | "due_date" | "risk_level" | "ai_plan">>,
  actorUserId?: string | null,
): Promise<ProjectRow> {
  const updated = await updateProject(projectId, data);
  if (!updated) throw new NotFoundError("Project not found");
  await logActivity({
    actor_type: actorUserId ? "USER" : "SYSTEM",
    actor_user_id: actorUserId ?? null,
    action: "project.updated",
    entity_type: "project",
    entity_id: projectId,
    customer_id: updated.customer_id,
    summary: `Project ${updated.code} updated`,
    meta: data,
  });
  return updated;
}

export function validateStatusTransition(from: ProjectStatus, to: ProjectStatus): void {
  if (from === to) return;
  if (from === "CANCELLED") {
    throw new ValidationError("A cancelled project cannot be reopened automatically. Contact the owner.");
  }
  if (from === "COMPLETED" && to !== "IN_REVIEW") {
    throw new ValidationError("A completed project can only be reopened for review.");
  }
}

/* ------------------------------------------------- managed project workflow -- */

/** One row of the projects list (staff view and client view share the shape). */
export interface ProjectSummary {
  id: string;
  code: string;
  title: string;
  titleEn: string | null;
  status: ProjectStatus;
  progress: number;
  customerId: string;
  customerName: string | null;
  startDate: string | null;
  dueDate: string | null;
  riskLevel: string | null;
  plan: {
    id: string;
    version: number;
    status: string;
    approvedAt: string | null;
    phases: number;
    tasks: number;
  } | null;
  /** The newest APPROVED plan — the only one the client is allowed to see. */
  approvedPlan: {
    id: string;
    version: number;
    status: string;
    approvedAt: string | null;
    phases: number;
    tasks: number;
  } | null;
  tasks: { total: number; done: number; open: number; overdue: number };
  daysRemaining: number | null;
}

/**
 * The projects list used by the admin dashboard and the client portal.
 *
 * The progress always comes from the real tasks, never from a stored number,
 * so the client and the owner see the same truth.
 */
export async function listProjectSummaries(
  filter: { customerId?: string; status?: ProjectStatus[]; limit?: number } = {},
): Promise<ProjectSummary[]> {
  const { parsePlanPhases } = await import("./project-plans.service");

  const { rows } = await listProjects({
    customerId: filter.customerId,
    status: filter.status,
    limit: filter.limit ?? 50,
  });
  if (rows.length === 0) return [];

  const projectIds = rows.map((row) => row.id);
  const tasks = await listTasksForProjects(projectIds, { includeInternal: true });
  const committed = await listTasksForProjects(projectIds, { committedOnly: true });
  const byProject = new Map<string, ProjectTaskRow[]>();
  for (const task of tasks) {
    const list = byProject.get(task.project_id) ?? [];
    list.push(task);
    byProject.set(task.project_id, list);
  }
  const committedByProject = new Map<string, ProjectTaskRow[]>();
  for (const task of committed) {
    const list = committedByProject.get(task.project_id) ?? [];
    list.push(task);
    committedByProject.set(task.project_id, list);
  }

  // The working plan (the newest version) and the approved one (the newest
  // APPROVED version) — the client only ever sees the second.
  const plans = await listProjectPlansForProjects(projectIds);
  const latestPlan = new Map<string, ProjectPlanRow>();
  const approvedPlan = new Map<string, ProjectPlanRow>();
  for (const plan of plans) {
    if (!latestPlan.has(plan.project_id)) latestPlan.set(plan.project_id, plan);
    if (plan.status === "APPROVED" && !approvedPlan.has(plan.project_id)) {
      approvedPlan.set(plan.project_id, plan);
    }
  }

  const summaries: ProjectSummary[] = [];
  for (const project of rows) {
    const projectTasks = byProject.get(project.id) ?? [];
    const clientTasks = committedByProject.get(project.id) ?? [];
    const done = clientTasks.filter((task) => task.status === "DONE").length;
    const overdue = projectTasks.filter(
      (task) => task.status !== "DONE" && task.due_date !== null && daysBetween(new Date(), task.due_date) < 0,
    ).length;
    const planRow = latestPlan.get(project.id);
    const approvedRow = approvedPlan.get(project.id);

    summaries.push({
      id: project.id,
      code: project.code,
      title: project.title,
      titleEn: project.title_en,
      status: project.status,
      progress: clientTasks.length === 0 ? 0 : Math.round((done / clientTasks.length) * 100),
      customerId: project.customer_id,
      customerName: project.customer_name ?? null,
      startDate: project.start_date,
      dueDate: project.due_date,
      riskLevel: project.risk_level,
      plan: planRow
        ? {
            id: planRow.id,
            version: planRow.version,
            status: planRow.status,
            approvedAt: planRow.approved_at,
            phases: parsePlanPhases(planRow).length,
            tasks: parsePlanPhases(planRow).reduce((total, phase) => total + (phase.tasks?.length ?? 0), 0),
          }
        : null,
      approvedPlan: approvedRow
        ? {
            id: approvedRow.id,
            version: approvedRow.version,
            status: approvedRow.status,
            approvedAt: approvedRow.approved_at,
            phases: parsePlanPhases(approvedRow).length,
            tasks: parsePlanPhases(approvedRow).reduce((total, phase) => total + (phase.tasks?.length ?? 0), 0),
          }
        : null,
      tasks: {
        total: clientTasks.length,
        done,
        open: clientTasks.length - done,
        overdue,
      },
      daysRemaining: project.due_date ? daysBetween(new Date(), project.due_date) : null,
    });
  }
  return summaries;
}

/** The staff view of one project: everything, including the internal tasks. */
export async function getStaffProjectView(projectId: string): Promise<{
  project: ProjectWithCustomer;
  tasks: ProjectTaskRow[];
  plan: { id: string; version: number; status: string; summary: string | null; approvedAt: string | null; phases: unknown[] } | null;
  services: { name: string; quantity: number; unitPriceMinor: number; billingType: string; months: number | null }[];
  progress: number;
}> {
  const project = await findProjectById(projectId);
  if (!project) throw new NotFoundError("Project not found");
  const tasks = await listProjectTasks(projectId, { includeInternal: true });
  const services = await listProjectServices(projectId);
  const progress = await recomputeProgress(projectId);
  const { getPlanWithTasks } = await import("./project-plans.service");
  const planData = await getPlanWithTasks(projectId);
  return {
    project,
    tasks,
    plan: planData
      ? {
          id: planData.plan.id,
          version: planData.plan.version,
          status: planData.plan.status,
          summary: planData.plan.summary,
          approvedAt: planData.plan.approved_at,
          phases: planData.phases,
        }
      : null,
    services: services.map((row) => ({
      name: row.name_snapshot,
      quantity: row.quantity,
      unitPriceMinor: row.unit_price_minor,
      billingType: row.billing_type,
      months: row.months,
    })),
    progress,
  };
}

export interface CreateManagedProjectInput {
  customerId: string;
  title: string;
  /** A catalogue service slug — used when the project is not based on an offer. */
  serviceSlug?: string | null;
  /** An accepted (APPROVED) offer of the same customer. */
  offerId?: string | null;
  brief?: string | null;
  startDate?: string | null;
  dueDate?: string | null;
  actor: Actor;
}

export interface ManagedProjectResult {
  project: ProjectRow;
  /** The plan proposal the agent prepared (a draft, pending the owner's approval). */
  plan: { id: string; version: number; status: string; taskCount: number; phases: number } | null;
  requiresOwnerApproval: boolean;
}

/**
 * The owner creates a project for a customer, from a catalogue service or from
 * an offer the client has accepted.
 *
 * The project starts as a DRAFT and the agent only *proposes* a plan: nothing
 * is committed to the client until the owner approves that plan.
 */
export async function createManagedProject(input: CreateManagedProjectInput): Promise<ManagedProjectResult> {
  requireCapability(input.actor, "projects.manage");
  const { findCustomerById } = await import("@/lib/repositories/customers.repo");
  const customer = await findCustomerById(input.customerId);
  if (!customer) throw new NotFoundError("Customer not found");
  if (!input.title?.trim()) throw new ValidationError("A project needs a title", { field: "title" });

  const services: ServiceRow[] = [];
  let offerId: string | null = null;
  let totalMinor = 0;
  let internalCostMinor = 0;
  let margin: number | null = null;
  let currency = customer.currency;

  if (input.offerId) {
    const { findOfferById } = await import("@/lib/repositories/offers.repo");
    const offer = await findOfferById(input.offerId, { withItems: true });
    if (!offer) throw new NotFoundError("Offer not found");
    if (offer.customer_id !== customer.id) {
      throw new ValidationError("This offer belongs to another customer", { field: "offerId" });
    }
    if (offer.status !== "APPROVED") {
      throw new PreconditionError(
        `A project can only be created from an accepted offer (current: ${offer.status})`,
      );
    }
    offerId = offer.id;
    totalMinor = offer.total_minor ?? 0;
    internalCostMinor = offer.internal_cost_minor;
    margin = offer.margin_pct;
    currency = offer.currency;
    const { listServices } = await import("@/lib/repositories/catalog.repo");
    const catalogue = await listServices();
    for (const item of offer.items) {
      const service = item.service_id
        ? catalogue.find((row) => row.id === item.service_id)
        : undefined;
      services.push(
        service ?? {
          id: item.service_id ?? item.id,
          slug: item.description_en ?? item.description_ar,
          name_ar: item.description_ar,
          name_en: item.description_en ?? item.description_ar,
          short_ar: null,
          short_en: null,
          description_ar: null,
          description_en: null,
          category: "general",
          billing_type: item.billing_type,
          unit: "PROJECT",
          base_price_minor: item.unit_price_minor,
          min_price_minor: item.unit_price_minor,
          currency: offer.currency,
          delivery_days: 7,
          revisions_included: 2,
          complexity_factor: 1,
          requires_approval_above_minor: null,
          is_active: 1,
          sort_order: 0,
          pricing_config: null,
          cancellation_policy: null,
          created_at: offer.created_at,
          updated_at: offer.created_at,
        },
      );
    }
  } else if (input.serviceSlug) {
    const { findServiceBySlug } = await import("@/lib/repositories/catalog.repo");
    const service = await findServiceBySlug(input.serviceSlug);
    if (!service) throw new NotFoundError("Service not found");
    if (service.is_active !== 1) {
      throw new PreconditionError("This service is not available");
    }
    services.push(service);
    totalMinor = service.base_price_minor;
    internalCostMinor = Math.round(service.base_price_minor * 0.5);
    margin = marginPct(totalMinor, internalCostMinor);
    currency = service.currency;
  } else {
    throw new ValidationError("A project needs either a service or an accepted offer", {
      field: "serviceSlug",
    });
  }

  const codes = await listProjectCodes();
  const code = formatReference("P", nextSequence(codes, "P"));
  const project = await createProject({
    customer_id: customer.id,
    title: input.title.trim(),
    code,
    status: "DRAFT",
    currency,
    amount_total_minor: totalMinor,
    internal_cost_minor: internalCostMinor,
    margin_pct: margin,
    country: customer.country,
    start_date: input.startDate ?? nowIso(),
    due_date: input.dueDate ?? null,
    brief: input.brief ?? null,
    created_by_user_id: input.actor.id,
    risk_level: "LOW",
  });

  for (const service of services) {
    await addProjectService({
      project_id: project.id,
      service_id: service.id,
      name_snapshot: service.name_ar,
      quantity: 1,
      unit_price_minor: service.base_price_minor,
      billing_type: service.billing_type,
      months: null,
    });
  }

  if (offerId) {
    const { updateOffer } = await import("@/lib/repositories/offers.repo");
    await updateOffer(offerId, { project_id: project.id });
  }

  await logActivity({
    actor_type: "USER",
    actor_user_id: input.actor.id,
    action: "project.created_by_owner",
    entity_type: "project",
    entity_id: project.id,
    customer_id: customer.id,
    project_id: project.id,
    summary: `أنشأ المالك المشروع ${project.code} للعميل ${customer.contact_name}`,
    meta: { offerId, serviceSlug: input.serviceSlug ?? null },
  });

  // The agent proposes the plan; it never commits anything.
  const { proposeProjectPlan } = await import("@/lib/agents/specialists/projects.agent");
  const proposal = await proposeProjectPlan({
    projectId: project.id,
    services,
    locale: customer.locale,
    startDate: project.start_date,
    actor: input.actor,
  });

  return {
    project,
    plan: {
      id: proposal.planId,
      version: proposal.version,
      status: proposal.status,
      taskCount: proposal.taskCount,
      phases: proposal.phases,
    },
    requiresOwnerApproval: true,
  };
}

export interface TaskUpdateInput {
  status?: TaskStatus;
  /** Internal note — never shown to the client. */
  note?: string | null;
}

const TASK_STATUSES: TaskStatus[] = ["TODO", "IN_PROGRESS", "BLOCKED", "REVIEW", "DONE"];

/**
 * Updates a task's status and/or appends an internal note.
 *
 * The progress of the project is recomputed from the real tasks, so the number
 * the client sees always matches the work that was actually done.
 */
export async function updateTaskWithNote(
  taskId: string,
  input: TaskUpdateInput,
  actor: Actor,
  options: { projectId?: string | null } = {},
): Promise<ProjectTaskRow> {
  requireCapability(actor, "tasks.manage");
  const task = await findProjectTask(taskId);
  if (!task) throw new NotFoundError("Task not found");
  // The task must belong to the project of the route.
  if (options.projectId && task.project_id !== options.projectId) {
    throw new NotFoundError("Task not found");
  }
  const project = await findProjectById(task.project_id);
  if (!project) throw new NotFoundError("Project not found");

  const patch: Partial<ProjectTaskRow> = {};
  if (input.status !== undefined) {
    if (!TASK_STATUSES.includes(input.status)) {
      throw new ValidationError("Unknown task status", { field: "status" });
    }
    patch.status = input.status;
    patch.completed_at = input.status === "DONE" ? nowIso() : null;
  }
  if (input.note !== undefined && input.note !== null) {
    const note = input.note.trim();
    if (note) {
      const stamp = nowIso();
      const existing = task.internal_note?.trim();
      patch.internal_note = existing ? `${existing}\n[${stamp}] ${note}` : `[${stamp}] ${note}`;
    }
  }
  if (Object.keys(patch).length === 0) {
    throw new ValidationError("Nothing to update", { field: "status" });
  }

  const updated = (await updateProjectTask(taskId, patch))!;
  await recomputeProgress(task.project_id);

  await logActivity({
    actor_type: "USER",
    actor_user_id: actor.id,
    action: "task.updated",
    entity_type: "project_task",
    entity_id: taskId,
    customer_id: project.customer_id,
    project_id: project.id,
    summary: `${task.title}: ${updated.status}`,
    meta: { status: updated.status, hasNote: Boolean(patch.internal_note) },
  });

  // Starting the first task moves a planned project into execution.
  if (project.status === "PLANNING" && updated.status === "IN_PROGRESS") {
    await changeStatus(project.id, "IN_PROGRESS", { userId: actor.id });
  }

  return updated;
}

/**
 * Closes a project — the owner's explicit decision, never automatic.
 *
 * Every client-visible task must be done; otherwise the project is not ready
 * to close and the owner is told exactly what is still open.
 */
export async function closeProject(
  projectId: string,
  actor: Actor,
  options: { note?: string | null } = {},
): Promise<ProjectRow> {
  requireCapability(actor, "projects.close");
  const project = await findProjectById(projectId);
  if (!project) throw new NotFoundError("Project not found");
  if (project.status === "COMPLETED") {
    throw new PreconditionError("This project is already closed");
  }
  if (project.status === "CANCELLED") {
    throw new PreconditionError("A cancelled project cannot be closed");
  }

  // Only the committed work (the tasks of an approved plan) can block the
  // closing; a draft plan is still a proposal.
  const tasks = await listClientVisibleTasks(projectId);
  const open = tasks.filter((task) => task.status !== "DONE");
  if (open.length > 0) {
    throw new PreconditionError(
      `This project still has ${open.length} open task(s) for the client; finish them before closing it`,
      { openTasks: open.map((task) => task.title) },
    );
  }

  const closed = await changeStatus(projectId, "COMPLETED", {
    userId: actor.id,
    note: options.note ?? "closed by the owner",
  });

  await logActivity({
    actor_type: "USER",
    actor_user_id: actor.id,
    action: "project.closed_by_owner",
    entity_type: "project",
    entity_id: projectId,
    customer_id: project.customer_id,
    project_id: projectId,
    summary: `أغلق المالك المشروع ${project.code}`,
    meta: { note: options.note ?? null, tasks: tasks.length },
  });

  return closed;
}

export interface MonitoringSummary {
  overdueTasks: number;
  dueSoonProjects: number;
  lateProjects: number;
  alerts: number;
}

/**
 * Watches the active projects and warns the owner.
 *
 * Two signals: a task that passed its deadline, and a project whose delivery
 * date is close or already passed. The alerts are in-app only (no email is sent
 * automatically) and are deduplicated so the alert centre never floods.
 */
export async function monitorProjects(
  actor: Actor,
  options: { dueSoonDays?: number } = {},
): Promise<MonitoringSummary> {
  requireCapability(actor, "projects.manage");
  const dueSoonDays = options.dueSoonDays ?? 3;
  const { raiseAlert } = await import("./alerts.service");
  const { listProjects } = await import("@/lib/repositories/projects.repo");

  const active = await listProjects({
    status: ["PLANNING", "IN_PROGRESS", "IN_REVIEW", "REVISIONS", "AWAITING_PAYMENT", "DRAFT"],
    limit: 200,
  });

  let alerts = 0;
  let lateProjects = 0;
  let dueSoonProjects = 0;

  for (const project of active.rows) {
    if (!project.due_date) continue;
    const daysLeft = daysBetween(new Date(), project.due_date);
    if (daysLeft < 0) {
      lateProjects += 1;
      await alertProjectLate({
        projectId: project.id,
        projectCode: project.code,
        customerId: project.customer_id,
        dueDate: project.due_date,
        daysLate: Math.max(1, Math.abs(daysLeft)),
      });
      alerts += 1;
    } else if (daysLeft <= dueSoonDays) {
      dueSoonProjects += 1;
      await raiseAlert({
        severity: "INFO",
        category: "delivery",
        title_ar: `موعد تسليم يقترب: ${project.code}`,
        title_en: `Delivery deadline approaching: ${project.code}`,
        body_ar: `موعد التسليم المتوقع للمشروع ${project.code} بعد ${daysLeft} يوم (${project.due_date.slice(0, 10)}).`,
        body_en: `The expected delivery of project ${project.code} is in ${daysLeft} day(s) (${project.due_date.slice(0, 10)}).`,
        entity_type: "project",
        entity_id: project.id,
        customer_id: project.customer_id,
        target_role: "OWNER",
        dedupe_key: `project-due-soon:${project.id}:${toDateKey(project.due_date)}`,
        notify: false,
        meta: { projectId: project.id, dueDate: project.due_date, daysLeft },
      });
      alerts += 1;
    }
  }

  const overdue = await listOverdueTasks({ limit: 100 });
  for (const task of overdue) {
    const daysLate = Math.max(1, Math.abs(daysBetween(new Date(), task.due_date!)));
    await raiseAlert({
      severity: daysLate > 7 ? "URGENT" : "IMPORTANT",
      category: "delivery",
      title_ar: `مهمة متأخرة: ${task.title}`,
      title_en: `Overdue task: ${task.title}`,
      body_ar: `المهمة «${task.title}» في المشروع ${task.project_code} متأخرة ${daysLate} يوم عن موعدها (${task.due_date!.slice(0, 10)}).`,
      body_en: `The task “${task.title}” in project ${task.project_code} is ${daysLate} day(s) past its deadline (${task.due_date!.slice(0, 10)}).`,
      entity_type: "project_task",
      entity_id: task.id,
      customer_id: task.customer_id,
      target_role: "OWNER",
      dedupe_key: `task-overdue:${task.id}`,
      notify: false,
      meta: { taskId: task.id, projectId: task.project_id, daysLate },
    });
    alerts += 1;
  }

  return {
    overdueTasks: overdue.length,
    dueSoonProjects,
    lateProjects,
    alerts,
  };
}
