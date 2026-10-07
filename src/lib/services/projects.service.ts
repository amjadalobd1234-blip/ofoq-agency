import { addDays, daysBetween, nowIso, toDateKey } from "@/lib/core/date";
import { NotFoundError, ValidationError } from "@/lib/core/errors";
import { formatReference, nextSequence } from "@/lib/core/ids";
import { marginPct } from "@/lib/core/money";
import type {
  CustomerRow,
  Locale,
  ProjectRow,
  ProjectStatus,
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
  listOverdueProjects,
  listProjectCodes,
  listProjectServices,
  listProjectTasks,
  listProjects,
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

/** Client-facing project view: status, progress, milestones and pending items. */
export interface ClientProjectView {
  project: ProjectRow;
  tasks: ProjectTaskRow[];
  services: { name: string; quantity: number; billingType: string; months: number | null }[];
  milestones: { label: string; done: boolean }[];
  daysRemaining: number | null;
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

  const tasks = await listProjectTasks(projectId, { includeInternal: false });
  const services = await listProjectServices(projectId);
  const progress = await recomputeProgress(projectId);
  const refreshed = await findProjectById(projectId);

  return {
    project: { ...(refreshed ?? project), progress },
    tasks,
    services: services.map((row) => ({
      name: row.name_snapshot,
      quantity: row.quantity,
      billingType: row.billing_type,
      months: row.months,
    })),
    milestones: buildMilestones(refreshed?.status ?? project.status, locale),
    daysRemaining: project.due_date ? daysBetween(new Date(), project.due_date) : null,
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
