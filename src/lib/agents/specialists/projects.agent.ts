import { addDays, toDateKey } from "@/lib/core/date";
import { aiStatus } from "@/lib/ai/provider";
import type { Actor } from "@/lib/auth/permissions";
import type { Locale, ProjectPlanPhase, ServiceRow } from "@/lib/domain/types";
import { findServiceById } from "@/lib/repositories/catalog.repo";
import { findProjectById, listProjectServices } from "@/lib/repositories/projects.repo";
import { savePlanDraft, type PlanPhaseInput } from "@/lib/services/project-plans.service";

import { runAgent } from "../runtime";

/**
 * Projects Agent (وكيل إدارة المشاريع) — the fourth core agent.
 *
 * What it does:
 *   1. turns an accepted offer (or a catalogue service) into a project plan:
 *      phases, tasks, deadlines and responsibilities,
 *   2. stores that plan as a DRAFT proposal on the existing `project_plans`
 *      table and syncs the tasks into the existing `project_tasks` table,
 *   3. records the run and the proposed action as "requires approval".
 *
 * What it must never do:
 *   - approve its own plan (`projects.plan.approve` is owner-only),
 *   - change a sensitive project state (status, completion, client commitments),
 *   - invent a price, a deadline that contradicts the plan or a promise.
 *
 * The AI may only write the human-readable summary of the proposal; the
 * structure (phases, tasks, dates, owners) is deterministic and comes from the
 * service catalogue, so the agent cannot hallucinate a commitment.
 */
export const PROJECTS_AGENT_KEY = "project_manager" as const;

/** The four phases every Ofoq project runs through. */
const PHASE_BLUEPRINT: { key: string; titleAr: string; titleEn: string; owner: string }[] = [
  { key: "DISCOVERY", titleAr: "الاكتشاف وتثبيت الاحتياج", titleEn: "Discovery and goal confirmation", owner: "project_manager" },
  { key: "PREPARATION", titleAr: "التحضير والتخطيط", titleEn: "Preparation and planning", owner: "content" },
  { key: "PRODUCTION", titleAr: "الإنتاج والتنفيذ", titleEn: "Production and execution", owner: "content" },
  { key: "REVIEW_DELIVERY", titleAr: "المراجعة والتسليم", titleEn: "Review and delivery", owner: "project_manager" },
];

/**
 * The work Ofoq actually performs per service, grouped by phase.
 * Offsets are days after the project start date.
 */
const SERVICE_TASKS: Record<
  string,
  { phase: string; titleAr: string; titleEn: string; offset: number; owner: string }[]
> = {
  "social-media-management": [
    { phase: "PREPARATION", titleAr: "إعداد خطة النشر الأسبوعية", titleEn: "Weekly publishing plan", offset: 4, owner: "content" },
    { phase: "PRODUCTION", titleAr: "تصميم قوالب المنشورات", titleEn: "Design the post templates", offset: 7, owner: "content" },
    { phase: "PRODUCTION", titleAr: "إنتاج المنشورات للمراجعة", titleEn: "Produce the posts for review", offset: 12, owner: "content" },
    { phase: "PRODUCTION", titleAr: "جدولة النشر ومتابعة التفاعل", titleEn: "Schedule publishing and monitor engagement", offset: 20, owner: "content" },
  ],
  "content-design": [
    { phase: "PRODUCTION", titleAr: "تصميم المواد المطلوبة ورفعها للمراجعة", titleEn: "Design the requested items and submit for review", offset: 10, owner: "content" },
  ],
  "content-strategy": [
    { phase: "PREPARATION", titleAr: "بناء خطة محتوى شهرية بأهداف واضحة", titleEn: "Build a monthly content plan with clear goals", offset: 7, owner: "content" },
  ],
  "paid-ads": [
    { phase: "PREPARATION", titleAr: "تحديد الجمهور والكلمات المفتاحية والرسائل", titleEn: "Define audience, keywords and messaging", offset: 5, owner: "ads_manager" },
    { phase: "PREPARATION", titleAr: "ضبط الميزانية اليومية والشهرية والحدود الآمنة", titleEn: "Set the daily/monthly budget and the safe limits", offset: 5, owner: "ads_manager" },
    { phase: "PRODUCTION", titleAr: "إطلاق الحملة ومتابعة الأرقام", titleEn: "Launch the campaign and monitor the numbers", offset: 9, owner: "ads_manager" },
    { phase: "PRODUCTION", titleAr: "تحسينات أسبوعية داخل نفس الميزانية", titleEn: "Weekly optimisation inside the same budget", offset: 21, owner: "ads_manager" },
  ],
  "seo": [
    { phase: "PREPARATION", titleAr: "مراجعة تقنية للموقع وإعداد قائمة الكلمات المفتاحية", titleEn: "Technical review and keyword list", offset: 7, owner: "seo" },
    { phase: "PRODUCTION", titleAr: "تحسين الصفحات الأساسية", titleEn: "Optimise the core pages", offset: 18, owner: "seo" },
  ],
  "web-development": [
    { phase: "PREPARATION", titleAr: "مخطط الصفحات وتجربة المستخدم", titleEn: "Page map and user journey", offset: 6, owner: "project_manager" },
    { phase: "PRODUCTION", titleAr: "التصميم والمراجعة مع العميل", titleEn: "Design and client review", offset: 14, owner: "content" },
    { phase: "PRODUCTION", titleAr: "التطوير والاختبار على الهاتف والكمبيوتر", titleEn: "Development and responsive testing", offset: 25, owner: "project_manager" },
  ],
  "branding": [
    { phase: "PRODUCTION", titleAr: "مقترحات الهوية البصرية وتسليم الملفات النهائية", titleEn: "Brand identity options and final files", offset: 14, owner: "content" },
  ],
  "analytics-reports": [
    { phase: "REVIEW_DELIVERY", titleAr: "تقرير أول مع شرح الأرقام بلغة بسيطة", titleEn: "First report explaining the numbers in plain language", offset: 14, owner: "reporting" },
  ],
  "consulting": [
    { phase: "PREPARATION", titleAr: "إعداد الخطة والاستشارة والتوصيات", titleEn: "Prepare the plan, the consultation and the recommendations", offset: 8, owner: "project_manager" },
  ],
};

/** Fixed tasks that belong to every project regardless of the service. */
const FIXED_TASKS: {
  phase: string;
  titleAr: string;
  titleEn: string;
  offset: number;
  owner: string;
  visibility?: "CLIENT" | "INTERNAL";
}[] = [
  { phase: "DISCOVERY", titleAr: "تحليل الاحتياج وتثبيت الأهداف", titleEn: "Needs analysis and goal confirmation", offset: 2, owner: "project_manager" },
  { phase: "DISCOVERY", titleAr: "استلام الوصول إلى الحسابات والملفات", titleEn: "Collect access to the accounts and files", offset: 3, owner: "project_manager" },
  { phase: "REVIEW_DELIVERY", titleAr: "مراجعة العميل والموافقة النهائية", titleEn: "Client review and final approval", offset: 28, owner: "project_manager" },
  { phase: "REVIEW_DELIVERY", titleAr: "تسليم الملفات وتسجيل تقييم العميل", titleEn: "Deliver the files and collect the client review", offset: 30, owner: "project_manager" },
  { phase: "REVIEW_DELIVERY", titleAr: "مراجعة داخلية للجودة قبل التسليم", titleEn: "Internal quality check before delivery", offset: 27, owner: "project_manager", visibility: "INTERNAL" },
];

export interface PlanProposal {
  phases: PlanPhaseInput[];
  summary: string;
  dueDate: string;
  startDate: string;
  services: string[];
}

/**
 * Builds the deterministic proposal: phases, tasks, deadlines and owners.
 *
 * No price, no promise, no free text: the shape of the plan is derived from
 * the services the project actually includes.
 */
export function buildPlanProposal(input: {
  services: ServiceRow[];
  startDate?: string | null;
  timelineDays?: number | null;
  locale: Locale;
}): PlanProposal {
  const start = input.startDate ? new Date(input.startDate) : new Date();
  const timelineDays = input.timelineDays && input.timelineDays > 0 ? input.timelineDays : 30;
  const startDate = toDateKey(start);
  const dueDate = toDateKey(addDays(start, timelineDays));
  const slugs = input.services.map((service) => service.slug);

  const byPhase = new Map<string, PlanPhaseInput>();
  for (const phase of PHASE_BLUEPRINT) {
    byPhase.set(phase.key, {
      key: phase.key,
      title: input.locale === "ar" ? phase.titleAr : phase.titleEn,
      titleEn: phase.titleEn,
      dueDate: null,
      owner: phase.owner,
      tasks: [],
    });
  }

  const addTask = (task: {
    phase: string;
    titleAr: string;
    titleEn: string;
    offset: number;
    owner: string;
    visibility?: "CLIENT" | "INTERNAL";
  }) => {
    const phase = byPhase.get(task.phase);
    if (!phase) return;
    const due = toDateKey(addDays(start, Math.min(task.offset, timelineDays)));
    phase.dueDate = phase.dueDate && phase.dueDate < due ? phase.dueDate : due;
    phase.tasks!.push({
      title: input.locale === "ar" ? task.titleAr : task.titleEn,
      titleEn: task.titleEn,
      dueDate: due,
      owner: task.owner,
      visibility: task.visibility ?? "CLIENT",
    });
  };

  for (const slug of slugs) {
    for (const task of SERVICE_TASKS[slug] ?? []) addTask(task);
  }
  for (const task of FIXED_TASKS) addTask(task);

  const phases = PHASE_BLUEPRINT.map((phase) => byPhase.get(phase.key)!).filter(
    (phase) => (phase.tasks?.length ?? 0) > 0,
  );

  const taskCount = phases.reduce((total, phase) => total + (phase.tasks?.length ?? 0), 0);
  const summary =
    input.locale === "ar"
      ? `خطة تنفيذ من ${phases.length} مراحل و${taskCount} مهمة، جاهزة للمراجعة والاعتماد من المالك.`
      : `A delivery plan of ${phases.length} phases and ${taskCount} tasks, ready for the owner's review and approval.`;

  return { phases, summary, dueDate, startDate, services: slugs };
}

/**
 * The optional AI narrative.
 *
 * The model may only describe the phases it is given; it never decides dates,
 * owners or scope. When no provider is configured — or the call fails — the
 * deterministic summary is used, so the platform never depends on a paid
 * service to plan a project.
 */
async function writeProposalSummary(proposal: PlanProposal, locale: Locale): Promise<string> {
  const status = aiStatus();
  if (!status.available) return proposal.summary;
  try {
    const { aiComplete } = await import("@/lib/ai/provider");
    const phaseLines = proposal.phases
      .map((phase) => `- ${phase.title}: ${(phase.tasks ?? []).map((task) => task.title).join("، ")}`)
      .join("\n");
    const result = await aiComplete({
      messages: [
        {
          role: "system",
          content:
            locale === "ar"
              ? "أنت مدير مشاريع في وكالة تسويق. لخّط مراحل المشروع بلغة عربية واضحة ومهنية. لا تخترع تواريخ أوأسعار أو التزامات، ولا تذكر معلومات غير موجودة في القوائم المعطاة. أجب بفقرة واحدة قصيرة."
              : "You are a project manager at a marketing agency. Summarise the project phases in clear, professional English. Never invent dates, prices or commitments, and never mention anything that is not in the given lists. Answer with one short paragraph.",
        },
        { role: "user", content: phaseLines },
      ],
      temperature: 0.3,
      maxTokens: 220,
    });
    const text = result.text?.trim();
    return text ? text : proposal.summary;
  } catch {
    return proposal.summary;
  }
}

export interface ProposePlanResult {
  projectId: string;
  planId: string;
  version: number;
  status: "DRAFT";
  requiresOwnerApproval: true;
  taskCount: number;
  phases: number;
}

/**
 * The agent entry point: propose a plan and hand it to the owner.
 *
 * It saves a DRAFT plan and nothing else — no status change, no client-facing
 * commitment, no task status change. The owner decides.
 */
export async function proposeProjectPlan(input: {
  projectId: string;
  services: ServiceRow[];
  locale: Locale;
  startDate?: string | null;
  timelineDays?: number | null;
  actor: Actor;
}): Promise<ProposePlanResult> {
  const project = await findProjectById(input.projectId);
  if (!project) throw new Error("Project not found");
  const services = input.services.length ? input.services : await servicesOfProject(input.projectId);

  const proposal = buildPlanProposal({
    services,
    startDate: input.startDate ?? project.start_date,
    timelineDays: input.timelineDays,
    locale: input.locale,
  });
  const summary = await writeProposalSummary(proposal, input.locale);
  const taskCount = proposal.phases.reduce((total, phase) => total + (phase.tasks?.length ?? 0), 0);

  const saved = await savePlanDraft(
    input.projectId,
    input.actor,
    {
      phases: proposal.phases,
      summary,
      startDate: proposal.startDate,
      dueDate: proposal.dueDate,
      locale: input.locale,
    },
    { createdByAgent: PROJECTS_AGENT_KEY },
  );

  await runAgent(
    PROJECTS_AGENT_KEY,
    {
      trigger: "project.plan_requested",
      locale: input.locale,
      customerId: project.customer_id,
      projectId: input.projectId,
      actorUserId: input.actor.id,
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
        payload: {
          planId: saved.plan.id,
          version: saved.plan.version,
          phases: proposal.phases.length,
          tasks: taskCount,
          dueDate: proposal.dueDate,
        },
      });
      return {
        data: { planId: saved.plan.id, version: saved.plan.version, phases: proposal.phases.length, tasks: taskCount },
        summary: `خطة مقترحة (${proposal.phases.length} مراحل، ${taskCount} مهمة) — بانتظار اعتماد المالك`,
        riskLevel: "LOW",
      };
    },
  );

  return {
    projectId: input.projectId,
    planId: saved.plan.id,
    version: saved.plan.version,
    status: "DRAFT",
    requiresOwnerApproval: true,
    taskCount,
    phases: proposal.phases.length,
  };
}

/** The catalogue services behind a project's service lines. */
async function servicesOfProject(projectId: string): Promise<ServiceRow[]> {
  const lines = await listProjectServices(projectId);
  const services: ServiceRow[] = [];
  for (const line of lines) {
    if (!line.service_id) continue;
    const service = await findServiceById(line.service_id);
    if (service) services.push(service);
  }
  return services;
}

/** Client-safe phase structure (no internal tasks, no owner fields). */
export function clientVisiblePhases(phases: ProjectPlanPhase[]): ProjectPlanPhase[] {
  return phases.map((phase) => ({
    ...phase,
    owner: null,
    ownerLabel: null,
    tasks: (phase.tasks ?? []).filter((task) => task.visibility === "CLIENT"),
  }));
}
