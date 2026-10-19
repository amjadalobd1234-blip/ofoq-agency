import type { RiskLevel } from "@/lib/domain/types";

/**
 * Agent registry (internal, extensible).
 *
 * Agents are INTERNAL workers. Clients never talk to them individually: the only
 * external interface is "مساعد أفق" (the Ofoq assistant), which is explicitly
 * presented as an AI assistant that belongs to the agency.
 *
 * Adding an agent is a three-step, code-only change:
 *   1. add a definition below,
 *   2. implement a handler in `src/lib/agents/specialists/<key>.ts`,
 *   3. call it through `runAgent()` so the run, its actions and its risk level
 *      are recorded automatically.
 */
export type AgentKey =
  | "orchestrator"
  | "needs_analyst"
  | "pricing"
  | "proposal_writer"
  | "offers"
  | "project_manager"
  | "content"
  | "ads_manager"
  | "google_ads"
  | "seo"
  | "reporting"
  | "customer_support"
  | "translator"
  | "satisfaction";

export type AgentCategory = "orchestration" | "sales" | "delivery" | "growth" | "support" | "quality";

export interface AgentDefinition {
  key: AgentKey;
  nameAr: string;
  nameEn: string;
  category: AgentCategory;
  descriptionAr: string;
  descriptionEn: string;
  /** What the agent is allowed to do on its own (recorded in the audit trail). */
  autonomiesAr: string[];
  autonomiesEn: string[];
  /** Actions that must always be approved by the owner/partner. */
  forbiddenAr: string[];
  forbiddenEn: string[];
  defaultRisk: RiskLevel;
}

export const AGENT_DEFINITIONS: AgentDefinition[] = [
  {
    key: "orchestrator",
    nameAr: "الوكيل الرئيسي",
    nameEn: "Main orchestrator",
    category: "orchestration",
    descriptionAr:
      "يدير رحلة العميل من أول رسالة حتى تسليم المشروع: يفهم الطلب، ينشئ ملف العميل، يوزّع المهام على الوكلاء، يتابع المشاريع، ويسجل كل قرار.",
    descriptionEn:
      "Runs the client journey end to end: understands the request, creates the client file, distributes work to specialists, follows up on projects and records every decision.",
    autonomiesAr: ["فتح ملف عميل", "إنشاء طلب ومشروع مبدئي", "توزيع المهام على الوكلاء", "إرسال تحديثات للعميل"],
    autonomiesEn: ["Open a client file", "Create a request and draft project", "Assign tasks to specialists", "Send client updates"],
    forbiddenAr: ["تغيير الأسعار المعتمدة", "الاسترجاع المالي", "الحذف النهائي"],
    forbiddenEn: ["Change approved prices", "Issue refunds", "Permanently delete data"],
    defaultRisk: "MEDIUM",
  },
  {
    key: "needs_analyst",
    nameAr: "وكيل فهم الاحتياج",
    nameEn: "Needs analyst",
    category: "sales",
    descriptionAr: "يستخرج الاحتياج الحقيقي من المحادثة: الخدمة المطلوبة، الهدف، الجمهور، المنصات، الميزانية والموعد.",
    descriptionEn: "Extracts the real need from the conversation: service, goal, audience, platforms, budget and deadline.",
    autonomiesAr: ["تسجيل الوقائع في ملف العميل مع مصدر كل معلومة"],
    autonomiesEn: ["Record facts in the client file with their source"],
    forbiddenAr: ["افتراض معلومة غير مذكورة"],
    forbiddenEn: ["Invent information that was never stated"],
    defaultRisk: "LOW",
  },
  {
    key: "pricing",
    nameAr: "وكيل التسعير",
    nameEn: "Pricing agent",
    category: "sales",
    descriptionAr: "يبني سعرًا أوليًا من سياسة التسعير المعلنة، ويسجّل سبب كل عامل سعري، ويحوّل الحالات غير المعتادة للمالك.",
    descriptionEn: "Builds an initial price from the declared pricing policy, records every factor and escalates unusual cases to the owner.",
    autonomiesAr: ["تسعير داخل النطاق الآمن", "تطبيق خصم ضمن الحد المسموح"],
    autonomiesEn: ["Quote within the safe range", "Apply a discount within the allowed limit"],
    forbiddenAr: ["تجاوز حد التحويل للمالك", "الخصم الكبير", "الاسترجاع"],
    forbiddenEn: ["Exceed the escalation threshold", "Large discounts", "Refunds"],
    defaultRisk: "MEDIUM",
  },
  {
    key: "proposal_writer",
    nameAr: "وكيل إعداد العروض",
    nameEn: "Proposal writer",
    category: "sales",
    descriptionAr: "يحوّل الاحتياج والسعر إلى عرض واضح ثنائي اللغة مع البنود والمدة وسياسة الإلغاء والاسترجاع.",
    descriptionEn: "Turns the need and the price into a clear bilingual offer with line items, timeline and the cancellation/refund policy.",
    autonomiesAr: ["إنشاء عرض مسودة"],
    autonomiesEn: ["Create a draft offer"],
    forbiddenAr: ["تعديل بند معتمد من العميل دون إشعار", "إرسال عرض دون موافقة المالك"],
    forbiddenEn: ["Silently change an approved line item", "Send an offer without owner approval"],
    defaultRisk: "MEDIUM",
  },
  {
    key: "offers",
    nameAr: "وكيل العروض",
    nameEn: "Offers agent",
    category: "sales",
    descriptionAr: "ينشئ مسودة عرض رسمي مرقّمة من أسعار وكيل التسعير فقط، مع البنود والشروط وتاريخ الانتهاء، وينتظر موافقة المالك قبل الإرسال.",
    descriptionEn: "Creates a numbered formal offer draft using only Pricing Agent prices, with line items, terms and an expiry date, and waits for owner approval before sending.",
    autonomiesAr: ["إنشاء مسودة عرض", "ترقيم العرض", "إرفاق الشروط وتاريخ الانتهاء"],
    autonomiesEn: ["Create an offer draft", "Number the offer", "Attach terms and expiry"],
    forbiddenAr: ["اختراع أسعار", "إرسال عرض دون موافقة المالك", "إظهار التكاليف أو الهوامش الداخلية للعميل", "قبول أو رفض العرض نيابة عن العميل"],
    forbiddenEn: ["Invent prices", "Send an offer without owner approval", "Show internal costs or margins to the client", "Accept or reject an offer on the client's behalf"],
    defaultRisk: "MEDIUM",
  },
  {
    key: "project_manager",
    nameAr: "وكيل إدارة المشاريع",
    nameEn: "Project manager",
    category: "delivery",
    descriptionAr:
      "يقترح خطة المشروع ومراحلها ومهامها، يتابع التنفيذ والتأخير، ويحدّث نسبة الإنجاز التي يراها العميل — ولا يلتزم نيابة عن الوكالة.",
    descriptionEn:
      "Proposes the project plan, its phases and tasks, follows the execution and the delays, and updates the progress the client sees — it never commits on behalf of the agency.",
    autonomiesAr: [
      "اقتراح خطة المشروع كمسودة",
      "تحديث حالة مهمة",
      "فتح تنبيه تأخير داخل التطبيق",
    ],
    autonomiesEn: ["Propose a project plan as a draft", "Update a task status", "Raise an in-app delay alert"],
    forbiddenAr: [
      "اعتماد الخطة دون موافقة المالك",
      "تغيير حالة حساسة للمشروع دون قرار المالك",
      "إغلاق مشروع",
      "إظهار ملاحظات أو تكاليف داخلية للعميل",
      "إرسال بريد إلكتروني تلقائي",
    ],
    forbiddenEn: [
      "Approve a plan without the owner",
      "Change a sensitive project state without the owner's decision",
      "Close a project",
      "Show internal notes or costs to the client",
      "Send an automatic email",
    ],
    defaultRisk: "MEDIUM",
  },
  {
    key: "content",
    nameAr: "وكيل المحتوى",
    nameEn: "Content agent",
    category: "delivery",
    descriptionAr: "يقترح خطة نشر ومواضيع ونصوصًا أولية قابلة للمراجعة من الفريق أو العميل.",
    descriptionEn: "Proposes a publishing plan, topics and first drafts for review by the team or the client.",
    autonomiesAr: ["إنشاء مسودات بانتظار المراجعة"],
    autonomiesEn: ["Create drafts awaiting review"],
    forbiddenAr: ["نشر محتوى دون مراجعة بشرية", "استخدام شعارات أو أسماء لا يملكها العميل"],
    forbiddenEn: ["Publish without human review", "Use logos or names the client does not own"],
    defaultRisk: "LOW",
  },
  {
    key: "ads_manager",
    nameAr: "وكيل الإعلانات",
    nameEn: "Ads manager",
    category: "growth",
    descriptionAr: "يخطط الحملات، يقترح الكلمات والجمهور والميزانية، ويقترح تحسينات داخل الحدود الآمنة.",
    descriptionEn: "Plans campaigns, suggests keywords, audiences and budgets, and proposes optimisations inside the safe limits.",
    autonomiesAr: ["تحسين نصوص الإعلان", "إيقاف إعلان ضعيف", "توزيع الميزانية داخل الحد المتفق عليه"],
    autonomiesEn: ["Improve ad copy", "Pause a weak ad", "Shift budget inside the agreed limit"],
    forbiddenAr: [
      "رفع الميزانية الإجمالية",
      "تجاوز الحد اليومي أو الشهري",
      "تغيير وسيلة الدفع",
      "إنشاء حملة جديدة تنفق أموالًا",
    ],
    forbiddenEn: [
      "Increase the total budget",
      "Exceed the daily or monthly cap",
      "Change the payment method",
      "Create a new campaign that spends money",
    ],
    defaultRisk: "MEDIUM",
  },
  {
    key: "google_ads",
    nameAr: "وكيل Google Ads",
    nameEn: "Google Ads agent",
    category: "growth",
    descriptionAr: "يتكامل مع حساب Google Ads عند ربطه. غير مفعّل حتى يتم ربط الحساب رسميًا.",
    descriptionEn: "Integrates with a Google Ads account once it is connected. Disabled until an account is officially linked.",
    autonomiesAr: ["مزامنة الأرقام", "اقتراح تحسينات"],
    autonomiesEn: ["Sync metrics", "Propose optimisations"],
    forbiddenAr: ["أي تغيير مالي خارج الحدود المتفق عليها", "رفع الميزانية", "إنشاء حملة تنفق أموالًا"],
    forbiddenEn: ["Any financial change outside agreed limits", "Raising budgets", "Creating a spending campaign"],
    defaultRisk: "HIGH",
  },
  {
    key: "seo",
    nameAr: "وكيل SEO",
    nameEn: "SEO agent",
    category: "growth",
    descriptionAr: "يقترح الكلمات المفتاحية والمحتوى والتحسينات التقنية الأساسية لتحسين الظهور في محركات البحث.",
    descriptionEn: "Suggests keywords, content and basic technical improvements to increase search visibility.",
    autonomiesAr: ["إنشاء قائمة كلمات مفتاحية", "اقتراح مهام تحسين"],
    autonomiesEn: ["Build a keyword list", "Suggest improvement tasks"],
    forbiddenAr: ["الوعود بترتيب محدد في جوجل"],
    forbiddenEn: ["Promise specific Google rankings"],
    defaultRisk: "LOW",
  },
  {
    key: "reporting",
    nameAr: "وكيل التقارير",
    nameEn: "Reporting agent",
    category: "quality",
    descriptionAr: "ينشئ تقارير يومية مبسطة بلغة واضحة، وتقارير مفصلة عند طلب العميل، ويشرح المصطلحات ببساطة.",
    descriptionEn: "Produces simplified daily reports in plain language and deeper reports on request, explaining terms simply.",
    autonomiesAr: ["إنشاء تقرير وإرساله للعميل"],
    autonomiesEn: ["Generate and send a report to the client"],
    forbiddenAr: ["إظهار تكاليف الوكالة الداخلية للعميل"],
    forbiddenEn: ["Show the agency's internal costs to the client"],
    defaultRisk: "LOW",
  },
  {
    key: "customer_support",
    nameAr: "وكيل خدمة العملاء",
    nameEn: "Customer support agent",
    category: "support",
    descriptionAr: "يجيب الأسئلة المتكررة، يتابع حالة الطلبات، ويصعّد الحالات المعقدة أو الغاضبة إلى الفريق البشري.",
    descriptionEn: "Answers frequent questions, follows up on request status and escalates complex or upsetting cases to the human team.",
    autonomiesAr: ["الإجابة من قاعدة المعرفة", "تصعيد الحالات"],
    autonomiesEn: ["Answer from the knowledge base", "Escalate cases"],
    forbiddenAr: ["الوعود المالية", "إعطاء تعهدات لا تملكها الوكالة"],
    forbiddenEn: ["Financial promises", "Commitments the agency cannot keep"],
    defaultRisk: "LOW",
  },
  {
    key: "translator",
    nameAr: "وكيل الترجمة",
    nameEn: "Translation agent",
    category: "support",
    descriptionAr: "يترجم الرسائل والعروض بين العربية والإنجليزية بلغة عربية بيضاء مفهومة، دون تغيير الأرقام أو الأسماء.",
    descriptionEn: "Translates messages and offers between Arabic and English in clear, plain language without changing numbers or names.",
    autonomiesAr: ["ترجمة المحتوى الداخلي والرسائل"],
    autonomiesEn: ["Translate internal content and messages"],
    forbiddenAr: ["تغيير الأرقام أو الشروط أثناء الترجمة"],
    forbiddenEn: ["Alter numbers or terms while translating"],
    defaultRisk: "LOW",
  },
  {
    key: "satisfaction",
    nameAr: "وكيل تحليل رضا العملاء",
    nameEn: "Satisfaction analyst",
    category: "quality",
    descriptionAr: "يحلّل التقييمات، يستخرج ما يحتاج تحسينًا، ويقترح متابعة مع العملاء غير الراضين.",
    descriptionEn: "Analyses reviews, extracts what needs improvement and suggests follow-up with dissatisfied clients.",
    autonomiesAr: ["تحليل التقييمات", "اقتراح متابعة"],
    autonomiesEn: ["Analyse reviews", "Suggest follow-up"],
    forbiddenAr: ["نشر تقييم دون موافقة المالك أو الشريك"],
    forbiddenEn: ["Publish a review without owner/partner approval"],
    defaultRisk: "LOW",
  },
];

export const AGENT_DEFINITION_BY_KEY: Record<AgentKey, AgentDefinition> = Object.fromEntries(
  AGENT_DEFINITIONS.map((definition) => [definition.key, definition]),
) as Record<AgentKey, AgentDefinition>;

export function agentDefinition(key: AgentKey): AgentDefinition {
  return AGENT_DEFINITION_BY_KEY[key];
}

export function agentLabel(key: AgentKey, locale: "ar" | "en"): string {
  const definition = AGENT_DEFINITION_BY_KEY[key];
  return locale === "ar" ? definition.nameAr : definition.nameEn;
}
