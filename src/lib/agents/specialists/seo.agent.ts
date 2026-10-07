import { aiCompleteJson } from "@/lib/ai/provider";
import type { CustomerRow, Locale, ProjectRow, ServiceRow } from "@/lib/domain/types";
import { createProjectTask, listProjectTasks } from "@/lib/repositories/projects.repo";

import { runAgent } from "../runtime";

/**
 * SEO agent.
 *
 * Produces keyword clusters and a prioritised task list for the delivery team.
 * It explicitly refuses to promise rankings: SEO outcomes depend on competition,
 * the site's history and search-engine behaviour, and the agency has no historical
 * data to promise positions from.
 */
export interface SeoPlan {
  clusters: { name: string; intent: "INFORMATIONAL" | "COMMERCIAL" | "TRANSACTIONAL" | "NAVIGATIONAL"; keywords: string[]; note: string }[];
  tasks: { titleAr: string; titleEn: string; priority: "HIGH" | "MEDIUM" | "LOW"; category: string }[];
  expectationsAr: string;
  expectationsEn: string;
  dataDisclaimerAr: string;
  dataDisclaimerEn: string;
}

export async function buildSeoPlan(input: {
  customer: CustomerRow;
  project: ProjectRow;
  services: ServiceRow[];
  country: string | null;
  locale: Locale;
  website?: string | null;
  createTasks?: boolean;
}): Promise<SeoPlan> {
  const base = input.services.map((service) =>
    input.locale === "ar" ? service.name_ar : service.name_en,
  );
  const market = input.country ?? input.customer.country ?? "";

  const aiClusters = await aiCompleteJson<{ clusters?: { name: string; intent: string; keywords: string[] }[] }>({
    messages: [
      {
        role: "system",
        content:
          "You are an SEO planner for a digital marketing agency. " +
          'Return JSON: {"clusters":[{"name":"","intent":"INFORMATIONAL|COMMERCIAL|TRANSACTIONAL|NAVIGATIONAL","keywords":[""]}]}. ' +
          "Use only the services and market given. Never invent search volumes or competitor data.",
      },
      {
        role: "user",
        content: `Services: ${base.join(", ")}\nMarket: ${market}\nLanguage: ${input.locale}`,
      },
    ],
    temperature: 0.3,
  });

  const clusters: SeoPlan["clusters"] =
    aiClusters?.clusters?.map((cluster) => ({
      name: cluster.name,
      intent: (cluster.intent?.toUpperCase() as SeoPlan["clusters"][number]["intent"]) ?? "COMMERCIAL",
      keywords: cluster.keywords ?? [],
      note: input.locale === "ar" ? "مبني على الخدمات المطلوبة فقط." : "Based only on the requested services.",
    })) ??
    base.map((service) => ({
      name: service,
      intent: "COMMERCIAL" as const,
      keywords: [
        input.locale === "ar" ? `${service} في ${market}`.trim() : `${service} in ${market}`.trim(),
        input.locale === "ar" ? `شركة ${service}` : `${service} agency`,
        input.locale === "ar" ? `سعر ${service}` : `${service} pricing`,
      ].filter(Boolean),
      note: input.locale === "ar" ? "قائمة أولية من محرك القواعد الداخلي." : "Starter list from the built-in rules engine.",
    }));

  const tasks: SeoPlan["tasks"] = [
    {
      titleAr: "مراجعة أساسيات الموقع: السرعة، الهاتف، الفهرسة",
      titleEn: "Technical basics: speed, mobile, indexation",
      priority: "HIGH",
      category: "TECHNICAL",
    },
    {
      titleAr: "كتابة عناوين ووصف واضح لكل صفحة أساسية",
      titleEn: "Clear titles and meta descriptions for core pages",
      priority: "HIGH",
      category: "ON_PAGE",
    },
    {
      titleAr: "إنشاء محتوى يجيب على أسئلة العملاء المتكررة",
      titleEn: "Create content that answers recurring client questions",
      priority: "MEDIUM",
      category: "CONTENT",
    },
    {
      titleAr: "إعداد قياس النتائج (Search Console وإحصاءات الزيارات)",
      titleEn: "Set up measurement (Search Console and analytics)",
      priority: "HIGH",
      category: "MEASUREMENT",
    },
    {
      titleAr: "تحسين الظهور المحلي إن كان النشاط محليًا",
      titleEn: "Improve local visibility when the business is local",
      priority: "MEDIUM",
      category: "LOCAL",
    },
  ];

  await runAgent(
    "seo",
    {
      trigger: "plan.requested",
      locale: input.locale,
      customerId: input.customer.id,
      projectId: input.project.id,
      input: { clusters: clusters.length, market },
    },
    async ({ record }) => {
      record({
        action: "seo_plan.created",
        summary: `خطة SEO: ${clusters.length} مجموعة كلمات و${tasks.length} مهمة`,
        reason: "خطة عمل داخلية مبنية على الخدمات المطلوبة دون وعود بترتيب محدد",
        entityType: "project",
        entityId: input.project.id,
        riskLevel: "LOW",
      });
      return {
        data: { clusters: clusters.length, tasks: tasks.length },
        summary: `خطة SEO جاهزة (${clusters.length} مجموعة)`,
        riskLevel: "LOW",
      };
    },
  );

  if (input.createTasks) {
    const existing = await listProjectTasks(input.project.id, { includeInternal: true });
    for (const task of tasks) {
      if (existing.some((row) => row.title === task.titleAr || row.title === task.titleEn)) continue;
      await createProjectTask({
        project_id: input.project.id,
        title: input.locale === "ar" ? task.titleAr : task.titleEn,
        title_en: task.titleEn,
        description: `SEO · ${task.category} · ${task.priority}`,
        visibility: "CLIENT",
        assigned_agent: "seo",
        status: "TODO",
      });
    }
  }

  return {
    clusters,
    tasks,
    expectationsAr:
      "تحسين محركات البحث عمل تراكمي: أول النتائج تظهر عادة بعد أسابيع، ونقيسها بالظهور والزيارات والاستفسارات، لا بترتيب محدد في جوجل.",
    expectationsEn:
      "SEO is cumulative: first results usually appear after a few weeks and are measured by impressions, traffic and enquiries — not by a promised Google position.",
    dataDisclaimerAr:
      "لا تتضمن الخطة أرقام حجم بحث أو منافسة، لأن ذلك يحتاج ربط أدوات قياس حقيقية.",
    dataDisclaimerEn:
      "The plan contains no search-volume or competition figures, because those require connecting real measurement tools.",
  };
}

/** Monthly SEO review: compares what was done with what is left. */
export async function reviewSeoProgress(projectId: string, locale: Locale): Promise<{ open: number; done: number }> {
  const tasks = await listProjectTasks(projectId, { includeInternal: true });
  const seoTasks = tasks.filter((task) => task.assigned_agent === "seo");
  const done = seoTasks.filter((task) => task.status === "DONE").length;
  const open = seoTasks.length - done;

  await runAgent(
    "seo",
    {
      trigger: "monthly_review",
      locale,
      projectId,
      input: { open, done },
    },
    async () => ({
      data: { open, done },
      summary: `مراجعة SEO: ${done}/${seoTasks.length} مهمة منجزة`,
      riskLevel: "LOW",
    }),
  );

  return { open, done };
}
