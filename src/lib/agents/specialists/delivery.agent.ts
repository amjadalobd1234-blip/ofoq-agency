import { addDays, daysBetween, toDateKey } from "@/lib/core/date";
import { formatDate } from "@/lib/core/date";
import type { CustomerRow, Locale, ProjectRow, ServiceRow } from "@/lib/domain/types";
import { findProjectById, listProjectTasks, updateProject } from "@/lib/repositories/projects.repo";
import { addTasks, changeStatus, type TaskTemplate } from "@/lib/services/projects.service";

import { runAgent } from "../runtime";

/**
 * Project manager agent.
 *
 * Builds a concrete plan (phases → tasks), assigns each task to the responsible
 * specialist agent, keeps the client-visible progress accurate, and raises a
 * delay alert when a deadline slips.
 *
 * Task templates are intentionally generic and honest: they describe the work the
 * agency actually performs, without inventing clients, results or history.
 */
export function planTemplates(
  services: ServiceRow[],
  profile: { platforms: string[]; volume: number | null; timelineDays: number | null },
  locale: Locale,
): TaskTemplate[] {
  const slugs = services.map((service) => service.slug);
  const templates: TaskTemplate[] = [];

  templates.push({
    titleAr: "تحليل الاحتياج وتثبيت الأهداف",
    titleEn: "Needs analysis and goal confirmation",
    offsetDays: 2,
    role: "project_manager",
  });

  if (slugs.includes("social-media-management")) {
    templates.push(
      {
        titleAr: `إعداد خطة النشر (${profile.platforms.length || 1} منصة)`,
        titleEn: `Publishing plan (${profile.platforms.length || 1} platform(s))`,
        offsetDays: 4,
        role: "content",
      },
      {
        titleAr: "تصميم قوالب الهوية للمنشورات",
        titleEn: "Design post templates from the brand identity",
        offsetDays: 6,
        role: "content",
      },
      {
        titleAr: `إنتاج ${profile.volume ?? 12} منشورًا للمراجعة`,
        titleEn: `Produce ${profile.volume ?? 12} posts for review`,
        offsetDays: 12,
        role: "content",
      },
      {
        titleAr: "جدولة النشر ومتابعة التفاعل",
        titleEn: "Schedule publishing and monitor engagement",
        offsetDays: 20,
        role: "content",
      },
    );
  }

  if (slugs.includes("content-design")) {
    templates.push({
      titleAr: "تصميم المواد المطلوبة ورفعها للمراجعة",
      titleEn: "Design the requested items and submit for review",
      offsetDays: 10,
      role: "content",
    });
  }

  if (slugs.includes("content-strategy")) {
    templates.push({
      titleAr: "بناء خطة محتوى شهرية بأهداف واضحة",
      titleEn: "Build a monthly content plan with clear objectives",
      offsetDays: 7,
      role: "content",
    });
  }

  if (slugs.includes("paid-ads")) {
    templates.push(
      {
        titleAr: "تحديد الجمهور والكلمات المفتاحية والرسائل",
        titleEn: "Define audience, keywords and messaging",
        offsetDays: 5,
        role: "ads_manager",
      },
      {
        titleAr: "ضبط الميزانية اليومية والشهرية والحدود الآمنة",
        titleEn: "Set daily/monthly budgets and safe limits",
        offsetDays: 5,
        role: "ads_manager",
      },
      {
        titleAr: "إطلاق الحملة ومتابعة الأرقام",
        titleEn: "Launch the campaign and monitor metrics",
        offsetDays: 8,
        role: "ads_manager",
      },
      {
        titleAr: "تحسينات أسبوعية داخل نفس الميزانية",
        titleEn: "Weekly optimisation inside the same budget",
        offsetDays: 21,
        role: "ads_manager",
      },
    );
  }

  if (slugs.includes("seo")) {
    templates.push(
      {
        titleAr: "مراجعة تقنية للموقع وقائمة الكلمات المفتاحية",
        titleEn: "Technical review and keyword list",
        offsetDays: 7,
        role: "seo",
      },
      {
        titleAr: "تحسين الصفحات الأساسية",
        titleEn: "Optimise core pages",
        offsetDays: 18,
        role: "seo",
      },
    );
  }

  if (slugs.includes("web-development")) {
    templates.push(
      {
        titleAr: "مخطط الصفحات وتجربة المستخدم",
        titleEn: "Page map and user journey",
        offsetDays: 6,
        role: "project_manager",
      },
      {
        titleAr: "التصميم والمراجعة مع العميل",
        titleEn: "Design and client review",
        offsetDays: 14,
        role: "content",
      },
      {
        titleAr: "التطوير والاختبار على الهاتف والكمبيوتر",
        titleEn: "Development and responsive testing",
        offsetDays: 25,
        role: "project_manager",
      },
    );
  }

  if (slugs.includes("branding")) {
    templates.push({
      titleAr: "مقترحات الهوية البصرية والملفات النهائية",
      titleEn: "Brand identity options and final files",
      offsetDays: 14,
      role: "content",
    });
  }

  if (slugs.includes("analytics-reports") || slugs.includes("paid-ads")) {
    templates.push({
      titleAr: "تقرير أول مع شرح الأرقام بلغة بسيطة",
      titleEn: "First report explaining the numbers in plain language",
      offsetDays: 14,
      role: "reporting",
    });
  }

  templates.push(
    {
      titleAr: "مراجعة العميل والموافقة النهائية",
      titleEn: "Client review and final approval",
      offsetDays: profile.timelineDays ?? 30,
      role: "project_manager",
    },
    {
      titleAr: "تسليم الملفات وتسجيل تقييم العميل",
      titleEn: "Deliver files and collect the client review",
      offsetDays: (profile.timelineDays ?? 30) + 2,
      role: "project_manager",
    },
  );

  // Internal quality-control task, never shown to the client.
  templates.push({
    titleAr: "مراجعة داخلية للجودة قبل التسليم",
    titleEn: "Internal quality check before delivery",
    offsetDays: (profile.timelineDays ?? 30) - 2,
    visibility: "INTERNAL",
    role: "project_manager",
  });

  void locale;
  return templates;
}

export interface DeliveryPlanOutcome {
  project: ProjectRow;
  taskCount: number;
  dueDate: string | null;
}

export async function createDeliveryPlan(input: {
  project: ProjectRow;
  customer: CustomerRow;
  services: ServiceRow[];
  profile: { platforms: string[]; volume: number | null; timelineDays: number | null };
  locale: Locale;
}): Promise<DeliveryPlanOutcome> {
  const templates = planTemplates(input.services, input.profile, input.locale);
  const created = await addTasks(input.project.id, templates, input.locale);

  const dueDate =
    input.project.due_date ??
    addDays(new Date(), input.profile.timelineDays ?? 30).toISOString();

  await updateProject(input.project.id, {
    due_date: dueDate,
    status: input.project.status === "DRAFT" ? "PLANNING" : input.project.status,
    risk_level: "LOW",
  });

  const plan = {
    phases: [
      { key: "DISCOVERY", tasks: created.filter((task) => task.sort_order < 2).map((task) => task.title) },
      {
        key: "PRODUCTION",
        tasks: created
          .filter((task) => task.visibility === "CLIENT" && task.sort_order >= 2)
          .map((task) => task.title),
      },
    ],
    dueDate,
    generatedAt: new Date().toISOString(),
  };

  await updateProject(input.project.id, { ai_plan: JSON.stringify(plan) });

  const outcome = await runAgent(
    "project_manager",
    {
      trigger: "offer.approved",
      locale: input.locale,
      customerId: input.customer.id,
      projectId: input.project.id,
      input: { services: input.services.map((service) => service.slug) },
    },
    async ({ record }) => {
      record({
        action: "plan.created",
        summary: `تم إنشاء خطة تنفيذ من ${created.length} مرحلة/مهمة`,
        entityType: "project",
        entityId: input.project.id,
        riskLevel: "LOW",
        payload: { tasks: created.length, dueDate },
      });
      return {
        data: { tasks: created.length, dueDate },
        summary: `خطة تنفيذ جاهزة (${created.length} مهمة)`,
        riskLevel: "LOW",
      };
    },
  );

  void outcome;
  return { project: { ...input.project, due_date: dueDate }, taskCount: created.length, dueDate };
}

/** Brings a project's visible plan up to date and reports slippage. */
export async function reviewDeliveryProgress(
  projectId: string,
  locale: Locale,
): Promise<{ open: number; done: number; overdue: boolean; daysRemaining: number | null }> {
  const project = await findProjectById(projectId);
  if (!project) throw new Error("Project not found");
  const tasks = await listProjectTasks(projectId, { includeInternal: true });
  const done = tasks.filter((task) => task.status === "DONE").length;
  const open = tasks.length - done;
  const overdue = tasks.some(
    (task) => task.status !== "DONE" && task.due_date !== null && daysBetween(new Date(), task.due_date) < 0,
  );

  const daysRemaining = project.due_date ? daysBetween(new Date(), project.due_date) : null;

  await runAgent(
    "project_manager",
    {
      trigger: "daily_job",
      locale,
      projectId,
      customerId: project.customer_id,
      input: { open, done, overdue },
    },
    async ({ record }) => {
      if (overdue) {
        record({
          action: "delay_detected",
          summary: `مهام متأخرة في المشروع ${project.code}`,
          entityType: "project",
          entityId: projectId,
          riskLevel: "MEDIUM",
          requiresApproval: false,
        });
      }
      return {
        data: { open, done, overdue },
        summary: `مراجعة تقدم ${project.code}: ${done}/${tasks.length} مهمة منجزة`,
        riskLevel: overdue ? "MEDIUM" : "LOW",
      };
    },
  );

  if (overdue) {
    const { alertProjectLate } = await import("@/lib/services/alerts.service");
    await alertProjectLate({
      projectId,
      projectCode: project.code,
      customerId: project.customer_id,
      dueDate: project.due_date ?? toDateKey(new Date()),
      daysLate: Math.max(1, Math.abs(daysRemaining ?? 0)),
    });
  }

  return { open, done, overdue, daysRemaining };
}

/** Moves a project to review when all client-visible tasks are done. */
export async function syncProjectStatusAfterTasks(projectId: string, actorUserId?: string | null): Promise<void> {
  const tasks = await listProjectTasks(projectId, { includeInternal: false });
  const project = await findProjectById(projectId);
  if (!project || tasks.length === 0) return;

  const allDone = tasks.every((task) => task.status === "DONE");
  if (allDone && project.status === "IN_PROGRESS") {
    await changeStatus(projectId, "IN_REVIEW", { userId: actorUserId ?? null, agentKey: "project_manager" });
  }
}

/** Human-readable delivery status line for notifications and portal headers. */
export function describeProgress(
  project: ProjectRow,
  locale: Locale,
): string {
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
