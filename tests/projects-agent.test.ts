import { beforeAll, describe, expect, it } from "vitest";

import { ForbiddenError } from "@/lib/core/errors";
import type { Actor } from "@/lib/auth/permissions";
import { buildPlanProposal } from "@/lib/agents/specialists/projects.agent";
import { createCustomer } from "@/lib/repositories/customers.repo";
import { createUser } from "@/lib/repositories/identity.repo";
import { listServices } from "@/lib/repositories/catalog.repo";
import { listProjectTasks } from "@/lib/repositories/projects.repo";
import {
  approvePlan,
  getPlanWithTasks,
  parsePlanPhases,
  savePlanDraft,
  submitPlanForApproval,
  toClientPhases,
} from "@/lib/services/project-plans.service";
import {
  closeProject,
  createManagedProject,
  getClientProjectView,
  monitorProjects,
  updateTaskWithNote,
} from "@/lib/services/projects.service";

/**
 * The Projects Agent (وكيل إدارة المشاريع) — service level.
 *
 * The rules under test are the ones the agency promised:
 *   1. the agent proposes, the owner approves,
 *   2. the progress follows the real tasks,
 *   3. the client never sees an internal task, an internal note or a cost,
 *   4. nothing closes a project without an explicit owner decision,
 *   5. the owner is warned about late tasks and approaching deadlines.
 */

let owner: Actor;
let partner: Actor;

let customerId = "";
let customerUserId = "";
let services: Awaited<ReturnType<typeof listServices>> = [];

beforeAll(async () => {
  // Real user rows: the projects reference their author, so the actors must
  // exist in `users` exactly like in production.
  const ownerUser = await createUser({ email: "projects-owner@example.test", name: "Owner", role: "OWNER" });
  const partnerUser = await createUser({ email: "projects-partner@example.test", name: "Partner", role: "PARTNER" });
  owner = { id: ownerUser.id, role: "OWNER" };
  partner = { id: partnerUser.id, role: "PARTNER" };

  const clientUser = await createUser({ email: "projects-client@example.test", name: "Client", role: "CLIENT" });
  customerUserId = clientUser.id;
  const customer = await createCustomer({
    user_id: clientUser.id,
    contact_name: "عميل الاختبار",
    email: clientUser.email,
    locale: "ar",
    currency: "USD",
    country: "IQ",
    status: "ACTIVE",
  });
  customerId = customer.id;
  services = await listServices({ activeOnly: true });
});

describe("Projects Agent — plan proposal", () => {
  it("builds phases, tasks, deadlines and responsibilities from the catalogue", () => {
    const social = services.find((service) => service.slug === "social-media-management")!;
    const proposal = buildPlanProposal({ services: [social], locale: "ar", timelineDays: 30 });

    expect(proposal.phases.length).toBeGreaterThan(1);
    expect(proposal.phases.map((phase) => phase.key)).toContain("DISCOVERY");
    expect(proposal.phases.map((phase) => phase.key)).toContain("REVIEW_DELIVERY");

    const tasks = proposal.phases.flatMap((phase) => phase.tasks ?? []);
    expect(tasks.length).toBeGreaterThan(3);
    // Every task carries a deadline and a responsible role.
    for (const task of tasks) {
      expect(task.dueDate).toBeTruthy();
      expect(task.owner).toBeTruthy();
    }
    // The internal quality check never reaches the client.
    expect(tasks.some((task) => task.visibility === "INTERNAL")).toBe(true);
  });

  it("saves the proposal as a DRAFT that only the owner can approve", async () => {
    const created = await createManagedProject({
      customerId,
      title: "إدارة حسابات التواصل",
      serviceSlug: "social-media-management",
      actor: owner,
    });

    expect(created.project.status).toBe("DRAFT");
    expect(created.plan?.status).toBe("DRAFT");
    expect(created.requiresOwnerApproval).toBe(true);

    const plan = await getPlanWithTasks(created.project.id);
    expect(plan?.plan.status).toBe("DRAFT");
    expect(plan?.plan.approved_at).toBeNull();
    expect(parsePlanPhases(plan?.plan).length).toBeGreaterThan(1);

    // A partner can prepare and submit, but cannot approve the commitment.
    await expect(approvePlan(created.project.id, partner)).rejects.toBeInstanceOf(ForbiddenError);

    // Submitting keeps the project a proposal.
    const submitted = await submitPlanForApproval(created.project.id, owner);
    expect(submitted.status).toBe("AWAITING_APPROVAL");

    const approved = await approvePlan(created.project.id, owner);
    expect(approved.plan.status).toBe("APPROVED");
    expect(approved.plan.approved_by_user_id).toBe(owner.id);
    expect(approved.plan.approved_at).toBeTruthy();
  });

  it("returns an approved plan to DRAFT when the owner edits it", async () => {
    const created = await createManagedProject({
      customerId,
      title: "مشروع قابل للتعديل",
      serviceSlug: "seo",
      actor: owner,
    });
    await approvePlan(created.project.id, owner);

    const plan = await getPlanWithTasks(created.project.id);
    const phases = parsePlanPhases(plan?.plan);
    const edited = await savePlanDraft(created.project.id, owner, {
      phases: [
        {
          key: phases[0]!.key,
          title: phases[0]!.title,
          dueDate: "2026-12-01",
          tasks: [{ title: "مهمة معدّلة", dueDate: "2026-11-20", owner: "seo" }],
        },
      ],
    });

    expect(edited.plan.status).toBe("DRAFT");
    expect(edited.plan.approved_at).toBeNull();
    // The approved version is kept for the audit trail and a new draft is made.
    expect(edited.plan.version).toBe((plan?.plan.version ?? 1) + 1);
    // The approved version stays in place for the client until the new draft
    // is approved too; it only becomes historical at that moment.
    const { listProjectPlanVersions } = await import("@/lib/services/project-plans.service");
    const versions = await listProjectPlanVersions(created.project.id);
    expect(versions.find((row) => row.version === plan?.plan.version)?.status).toBe("APPROVED");
  });
});

describe("Projects Agent — execution and progress", () => {
  it("recomputes the progress from the real tasks and keeps internal notes internal", async () => {
    const created = await createManagedProject({
      customerId,
      title: "مشروع متابعة",
      serviceSlug: "consulting",
      actor: owner,
    });
    await approvePlan(created.project.id, owner);

    const tasks = await listProjectTasks(created.project.id, { includeInternal: true });
    const clientTask = tasks.find((task) => task.visibility === "CLIENT")!;

    const updated = await updateTaskWithNote(
      clientTask.id,
      { status: "DONE", note: "تمت المراجعة داخليًا" },
      owner,
    );
    expect(updated.status).toBe("DONE");
    expect(updated.completed_at).toBeTruthy();
    expect(updated.internal_note).toContain("تمت المراجعة داخليًا");

    // The progress follows the real tasks.
    const view = await getClientProjectView(created.project.id, customerId, "ar");
    const expected = Math.round(
      (view.tasks.filter((task) => task.status === "DONE").length / view.tasks.length) * 100,
    );
    expect(view.project.progress).toBe(expected);
  });

  it("moves a planned project into execution when the first task starts", async () => {
    const created = await createManagedProject({
      customerId,
      title: "مشروع قيد التنفيذ",
      serviceSlug: "content-design",
      actor: owner,
    });
    await approvePlan(created.project.id, owner);
    const tasks = await listProjectTasks(created.project.id, { includeInternal: true });
    const first = tasks.find((task) => task.visibility === "CLIENT")!;

    await updateTaskWithNote(first.id, { status: "IN_PROGRESS" }, owner);
    const { findProjectById } = await import("@/lib/repositories/projects.repo");
    const project = await findProjectById(created.project.id);
    expect(project?.status).toBe("IN_PROGRESS");
  });
});

describe("Projects Agent — what the client sees", () => {
  it("hides internal tasks, internal notes, costs and the owner fields", async () => {
    const created = await createManagedProject({
      customerId,
      title: "مشروع العميل",
      serviceSlug: "social-media-management",
      actor: owner,
    });
    await approvePlan(created.project.id, owner);

    const allTasks = await listProjectTasks(created.project.id, { includeInternal: true });
    const internalTask = allTasks.find((task) => task.visibility === "INTERNAL")!;
    await updateTaskWithNote(internalTask.id, { status: "DONE", note: "ملاحظة سرية" }, owner);

    const view = await getClientProjectView(created.project.id, customerId, "ar");
    const serialised = JSON.stringify(view);

    expect(view.tasks.every((task) => !serialised.includes("ملاحظة سرية"))).toBe(true);
    expect(serialised).not.toContain("ملاحظة سرية");
    expect(serialised).not.toContain("internal_cost_minor");
    expect(serialised).not.toContain("margin_pct");
    expect(serialised).not.toContain("risk_level");
    expect(view.tasks.length).toBeLessThan(allTasks.length);
    // Only the phases that hold a client-visible task are returned.
    const plan = await getPlanWithTasks(created.project.id);
    const clientPhases = toClientPhases(parsePlanPhases(plan?.plan), allTasks);
    expect(clientPhases.length).toBeGreaterThan(0);
    expect(clientPhases.every((phase) => phase.tasks.length > 0)).toBe(true);
  });

  it("shows nothing of a plan the owner has not approved yet", async () => {
    const created = await createManagedProject({
      customerId,
      title: "مشروع بخطة غير معتمدة",
      serviceSlug: "social-media-management",
      actor: owner,
    });
    // The agent proposed a plan; the owner did not approve it yet.
    expect(created.plan?.status).toBe("DRAFT");

    const view = await getClientProjectView(created.project.id, customerId, "ar");
    // A proposal is not a commitment: no plan, no tasks, no progress.
    expect(view.plan).toBeNull();
    expect(view.tasks).toHaveLength(0);
    expect(view.project.progress).toBe(0);
    expect(JSON.stringify(view)).not.toContain("تحليل الاحتياج");

    // After the owner's approval the same client sees the plan and its tasks.
    await approvePlan(created.project.id, owner);
    const approvedView = await getClientProjectView(created.project.id, customerId, "ar");
    expect(approvedView.plan?.status).toBe("APPROVED");
    expect(approvedView.plan?.phases.length).toBeGreaterThan(0);
    expect(approvedView.tasks.length).toBeGreaterThan(0);
  });

  it("keeps the client on the approved version while a new draft is prepared", async () => {
    const created = await createManagedProject({
      customerId,
      title: "مشروع بتعديل الخطة",
      serviceSlug: "seo",
      actor: owner,
    });
    await approvePlan(created.project.id, owner);
    const before = await getClientProjectView(created.project.id, customerId, "ar");
    expect(before.plan?.status).toBe("APPROVED");
    const version = before.plan?.version;

    // The owner edits the plan: a new draft, not yet approved.
    await savePlanDraft(
      created.project.id,
      owner,
      {
        phases: [
          {
            key: "PREPARATION",
            title: "التحضير",
            dueDate: "2027-01-01",
            tasks: [{ title: "مهمة معدّلة", dueDate: "2026-12-20" }],
          },
        ],
      },
    );
    const after = await getClientProjectView(created.project.id, customerId, "ar");
    expect(after.plan?.status).toBe("APPROVED");
    expect(after.plan?.version).toBe(version);
  });

  it("refuses to show the project of another customer", async () => {
    const created = await createManagedProject({
      customerId,
      title: "مشروع خاص",
      serviceSlug: "seo",
      actor: owner,
    });
    await expect(getClientProjectView(created.project.id, "another-customer", "ar")).rejects.toThrow(
      /not found/i,
    );
  });
});

describe("Projects Agent — closing", () => {
  it("never closes a project without an explicit owner decision", async () => {
    const created = await createManagedProject({
      customerId,
      title: "مشروع الإغلاق",
      serviceSlug: "consulting",
      actor: owner,
    });
    await approvePlan(created.project.id, owner);

    // A partner cannot close, and open tasks block the closing.
    await expect(closeProject(created.project.id, partner)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(closeProject(created.project.id, owner)).rejects.toThrow(/open task/i);

    const tasks = await listProjectTasks(created.project.id, { includeInternal: true });
    for (const task of tasks.filter((row) => row.visibility === "CLIENT")) {
      await updateTaskWithNote(task.id, { status: "DONE" }, owner);
    }

    const closed = await closeProject(created.project.id, owner, { note: "تم التسليم" });
    expect(closed.status).toBe("COMPLETED");
    expect(closed.completed_at).toBeTruthy();
    expect(closed.progress).toBe(100);
  });
});

describe("Projects Agent — delivery watch", () => {
  it("warns the owner about late tasks and approaching deadlines (in-app only)", async () => {
    const created = await createManagedProject({
      customerId,
      title: "مشروع متأخر",
      serviceSlug: "seo",
      actor: owner,
    });
    await approvePlan(created.project.id, owner);

    const tasks = await listProjectTasks(created.project.id, { includeInternal: true });
    const target = tasks.find((task) => task.visibility === "CLIENT")!;
    // A deadline in the past: the task is late.
    await updateTaskWithNote(target.id, { status: "IN_PROGRESS" }, owner);
    const { updateProjectTask } = await import("@/lib/repositories/projects.repo");
    await updateProjectTask(target.id, { due_date: "2020-01-01" });

    const summary = await monitorProjects(owner);
    expect(summary.overdueTasks).toBeGreaterThan(0);
    expect(summary.alerts).toBeGreaterThan(0);

    const { listAlerts } = await import("@/lib/repositories/governance.repo");
    const { rows } = await listAlerts({ limit: 50 });
    const taskAlert = rows.find((alert) => alert.entity_type === "project_task");
    expect(taskAlert).toBeTruthy();
    expect(taskAlert?.target_role).toBe("OWNER");
    // The alert is raised inside the app only — no email is sent.
    expect(taskAlert?.severity === "URGENT" || taskAlert?.severity === "IMPORTANT").toBe(true);
  });
});

describe("Projects Agent — a phase that only a draft carries", () => {
  it("never counts or shows a task of a draft-only phase before the approval", async () => {
    const created = await createManagedProject({
      customerId,
      title: "مشروع نسخة ثانية",
      serviceSlug: "seo",
      actor: owner,
    });
    const projectId = created.project.id;
    await approvePlan(projectId, owner);

    // The approved version, unchanged, plus one phase that exists only in a
    // newer draft — exactly what a revision of an approved plan looks like.
    const approved = await getPlanWithTasks(projectId);
    const approvedPhases = parsePlanPhases(approved!.plan);
    await savePlanDraft(
      projectId,
      owner,
      {
        phases: [
          ...approvedPhases,
          { key: "SECRET", title: "مرحلة المسودة", tasks: [{ title: "مهمة المسودة" }] },
        ],
      },
      {},
    );

    const { listProjectTasks, findProjectById } = await import("@/lib/repositories/projects.repo");
    const tasks = await listProjectTasks(projectId, { includeInternal: true });
    const draftTask = tasks.find((task) => task.phase_key === "SECRET")!;
    expect(draftTask).toBeTruthy();
    await updateTaskWithNote(draftTask.id, { status: "DONE" }, owner);

    // The committed tasks of the approved phases are all still TODO, so a rule
    // that leaked the draft phase would report a progress above zero.
    const { listTasksForProjects } = await import("@/lib/repositories/projects.repo");
    const committed = await listTasksForProjects([projectId], { committedOnly: true });
    expect(committed.some((task) => task.title === "مهمة المسودة")).toBe(false);
    expect(committed.every((task) => task.status === "TODO")).toBe(true);

    // The client view agrees: no draft task, no draft phase.
    const view = await getClientProjectView(projectId, customerId, "ar");
    expect(view.tasks.some((task) => task.title === "مهمة المسودة")).toBe(false);
    expect(view.plan?.phases.map((phase) => phase.key)).not.toContain("SECRET");
    expect(view.project.progress).toBe(0);

    // The stored percentage follows the same committed tasks.
    const project = await findProjectById(projectId);
    expect(Number(project?.progress)).toBe(0);
  });
});
