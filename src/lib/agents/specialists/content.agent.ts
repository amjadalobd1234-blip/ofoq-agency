import { aiComplete, aiAvailable, aiCompleteJson } from "@/lib/ai/provider";
import { addDays, toDateKey } from "@/lib/core/date";
import type { CustomerRow, Locale, ProjectRow } from "@/lib/domain/types";
import { createProjectTask, listProjectTasks } from "@/lib/repositories/projects.repo";

import { runAgent } from "../runtime";

/**
 * Content agent.
 *
 * Produces a content calendar and first drafts. Everything it creates is marked
 * as a DRAFT awaiting human review — the agent is explicitly forbidden from
 * publishing, and it never invents claims, statistics or client results.
 */
export interface ContentPlanItem {
  date: string;
  platform: string;
  topicAr: string;
  topicEn: string;
  format: "POST" | "REEL" | "STORY" | "CAROUSEL" | "ARTICLE";
  callToActionAr: string;
  callToActionEn: string;
  status: "DRAFT";
}

export interface ContentPlan {
  projectId: string;
  items: ContentPlanItem[];
  notesAr: string[];
  notesEn: string[];
  providers: { ai: boolean };
}

const TOPIC_BANK: Record<string, { ar: string[]; en: string[] }> = {
  general: {
    ar: [
      "تعريف بالخدمة وفائدتها للعميل",
      "سؤال شائع يجيب عليه الفريق",
      "نصيحة عملية قصيرة قابلة للتطبيق",
      "توضيح خطوات التعامل مع الوكالة",
      "مقارنة بين طريقتين للوصول إلى النتيجة",
    ],
    en: [
      "Introduce the service and its benefit",
      "Answer a common client question",
      "A short, practical tip",
      "Explain how working with the agency goes",
      "Compare two ways to reach the goal",
    ],
  },
  ecommerce: {
    ar: [
      "عرض منتج الأسبوع بأسلوب واضح",
      "سؤال وجواب عن الشحن والدفع",
      "قصص عميل تستخدم المنتج (بمواد حقيقية فقط)",
      "خلف الكواليس: كيف نجهّز الطلب",
    ],
    en: [
      "Product of the week with a clear benefit",
      "Shipping and payment FAQ",
      "Customer stories (only with real material)",
      "Behind the scenes: how an order is prepared",
    ],
  },
  services: {
    ar: [
      "شرح خدمة واحدة بالتفصيل",
      "الفرق بين الباقة الأساسية والمتقدمة",
      "أخطاء شائعة نراها في السوق",
      "كيف نقيس نتائج الخدمة",
    ],
    en: [
      "Deep dive into one service",
      "Basic vs advanced scope",
      "Common mistakes we see",
      "How we measure the service's results",
    ],
  },
};

export async function buildContentPlan(input: {
  customer: CustomerRow;
  project: ProjectRow;
  platforms: string[];
  volume: number | null;
  locale: Locale;
  industry?: string | null;
  createTasks?: boolean;
}): Promise<ContentPlan> {
  const platforms = input.platforms.length > 0 ? input.platforms : ["instagram", "facebook"];
  const count = Math.max(1, Math.min(60, input.volume ?? 12));
  const bank = TOPIC_BANK[input.industry ?? "general"] ?? TOPIC_BANK.general!;
  const items: ContentPlanItem[] = [];

  for (let index = 0; index < count; index += 1) {
    const platform = platforms[index % platforms.length]!;
    const topic = bank.ar[index % bank.ar.length]!;
    const topicEn = bank.en[index % bank.en.length]!;
    items.push({
      date: toDateKey(addDays(new Date(), Math.floor(index * (30 / count)) + 1)),
      platform,
      topicAr: topic,
      topicEn,
      format: index % 5 === 0 ? "REEL" : index % 4 === 0 ? "CAROUSEL" : "POST",
      callToActionAr: pickCta(index).ar,
      callToActionEn: pickCta(index).en,
      status: "DRAFT",
    });
  }

  const outcome = await runAgent(
    "content",
    {
      trigger: "plan.requested",
      locale: input.locale,
      customerId: input.customer.id,
      projectId: input.project.id,
      input: { platforms, count },
    },
    async ({ record, aiAvailable: agentAiAvailable }) => {
      record({
        action: "content_plan.created",
        summary: `خطة محتوى مبدئية من ${items.length} فكرة (مسودات بانتظار المراجعة)`,
        reason: agentAiAvailable
          ? "مولّد بالاعتماد على مزود الذكاء الاصطناعي وقاعدة أسئلة الوكالة"
          : "مولّد بمحرك القواعد الداخلي (لا يوجد مزود ذكاء اصطناعي متصل)",
        entityType: "project",
        entityId: input.project.id,
        riskLevel: "LOW",
      });
      return {
        data: { items: items.length },
        summary: `خطة محتوى (${items.length} فكرة) بانتظار المراجعة`,
        riskLevel: "LOW",
      };
    },
  );
  void outcome;

  if (input.createTasks) {
    const existing = await listProjectTasks(input.project.id, { includeInternal: true });
    if (!existing.some((task) => task.title.includes("خطة النشر") || task.title.includes("Publishing plan"))) {
      for (const item of items.slice(0, 6)) {
        await createProjectTask({
          project_id: input.project.id,
          title: input.locale === "ar" ? `إعداد منشور: ${item.topicAr}` : `Prepare post: ${item.topicEn}`,
          title_en: `Prepare post: ${item.topicEn}`,
          visibility: "CLIENT",
          assigned_agent: "content",
          status: "TODO",
        });
      }
    }
  }

  return {
    projectId: input.project.id,
    items,
    notesAr: [
      "كل الأفكار مسودات أولية وتحتاج مراجعة الفريق قبل النشر.",
      "لا نستخدم أرقامًا أو نتائج لم يقدمها العميل أو لم تُقس من حملاته الفعلية.",
    ],
    notesEn: [
      "Every idea is a first draft and needs team review before publishing.",
      "We never use numbers or results the client did not provide or that were not measured on real campaigns.",
    ],
    providers: { ai: aiAvailable() },
  };
}

/**
 * Drafts a single post. With an AI provider the copy is written by the model;
 * without one, the agent returns a structured outline and says so plainly.
 */
export async function draftPost(input: {
  customer: CustomerRow;
  topic: string;
  platform: string;
  locale: Locale;
  tone?: "friendly" | "formal";
}): Promise<{ draft: string; usedAi: boolean; disclaimerAr: string; disclaimerEn: string }> {
  const fallbackDraft =
    input.locale === "ar"
      ? `• الفكرة: ${input.topic}\n• الجمهور: متابعو ${input.platform} المهتمون بهذه الخدمة.\n• المفتاح: ابدأ بفائدة واضحة ثم اطلب خطوة واحدة بسيطة.\n• دعوة لاتخاذ إجراء: راسلنا لمعرفة التفاصيل.\n\n(مسودة هيكلية — اكتب النص النهائي بعد مراجعة الفريق)`
      : `• Idea: ${input.topic}\n• Audience: ${input.platform} followers interested in this service.\n• Key: lead with one clear benefit, then ask for one simple step.\n• CTA: message us for details.\n\n(Structural draft — finalise after team review)`;

  if (!aiAvailable()) {
    return {
      draft: fallbackDraft,
      usedAi: false,
      disclaimerAr: "لا يوجد مزود ذكاء اصطناعي متصل، لذلك هذه مسودة هيكلية من محرك القواعد الداخلي.",
      disclaimerEn: "No AI provider is connected, so this is a structural draft from the built-in rules engine.",
    };
  }

  try {
    const result = await aiComplete({
      messages: [
        {
          role: "system",
          content:
            "You write social media drafts for a digital marketing agency. " +
            "Use clear, friendly Modern Standard Arabic when the user's language is Arabic. " +
            "Never invent statistics, awards, client names or results. " +
            "Keep it short and practical, and end with one simple call to action.",
        },
        {
          role: "user",
          content: `Platform: ${input.platform}\nLanguage: ${input.locale}\nTone: ${input.tone ?? "friendly"}\nTopic: ${input.topic}`,
        },
      ],
      temperature: 0.6,
    });
    return {
      draft: result.text,
      usedAi: true,
      disclaimerAr: "مسودة مولّدة آليًا وتحتاج مراجعة بشرية قبل النشر.",
      disclaimerEn: "AI-generated draft that needs human review before publishing.",
    };
  } catch {
    return {
      draft: fallbackDraft,
      usedAi: false,
      disclaimerAr: "تعذّر الوصول إلى مزود الذكاء الاصطناعي، لذلك هذه مسودة هيكلية.",
      disclaimerEn: "The AI provider was unreachable, so this is a structural draft.",
    };
  }
}

/** Suggests content themes based on what the client told us (no invented data). */
export async function suggestThemes(input: {
  customer: CustomerRow;
  goals: string | null;
  services: string[];
  locale: Locale;
}): Promise<{ themesAr: string[]; themesEn: string[] }> {
  const structured = await aiCompleteJson<{ themes?: string[] }>({
    messages: [
      {
        role: "system",
        content:
          "Suggest 5 content themes for a client of a digital marketing agency. " +
          'Answer as JSON: {"themes": ["..."]}. Base them only on the information given.',
      },
      {
        role: "user",
        content: `Goal: ${input.goals ?? "unknown"}\nServices: ${input.services.join(", ")}\nLanguage: ar`,
      },
    ],
    temperature: 0.4,
  });

  if (structured?.themes?.length) {
    return { themesAr: structured.themes, themesEn: structured.themes };
  }

  const bank = TOPIC_BANK.general!;
  return { themesAr: bank.ar, themesEn: bank.en };
}

function pickCta(index: number): { ar: string; en: string } {
  const options = [
    { ar: "راسلنا على الخاص لمعرفة التفاصيل", en: "Message us for details" },
    { ar: "احفظ المنشور وشاركنا سؤالك", en: "Save this post and ask us your question" },
    { ar: "اطلب الخدمة من موقعنا", en: "Request the service on our website" },
    { ar: "اسأل عن العرض الحالي", en: "Ask about the current offer" },
  ];
  return options[index % options.length]!;
}
