import { aiStatus } from "@/lib/ai/provider";
import { formatMoney, toMinor } from "@/lib/core/money";
import type {
  AdAudience,
  AdBusinessCategory,
  AdCopyBlock,
  AdForecasts,
  AdIdea,
  AdKpi,
  AdObjective,
  AdPlanBody,
  AdPlanPlatform,
  AdPlanResultRow,
  AdPlatformAllocation,
  AdPlatformForecast,
  Locale,
} from "@/lib/domain/types";

import { runAgent } from "../runtime";

/**
 * Ads Agent (وكيل الإعلانات) — the fifth core agent.
 *
 * Advisory only. It never talks to Meta, Google or TikTok, never launches or
 * pauses a real campaign, never spends money, never issues an invoice, never
 * sends email, and never approves its own plan.
 *
 * What it does:
 *   1. reads the client's activity, audience and goals,
 *   2. picks Meta / Google / TikTok from deterministic rules for the Iraqi market,
 *   3. builds a USD budget split that sums to the total,
 *   4. writes Arabic ad copy aimed at the Iraqi market,
 *   5. attaches conservative forecasts labelled as estimates,
 *   6. stores the document as a DRAFT for the owner.
 *
 * The AI, when configured, may only polish the Arabic copy and the short
 * analysis paragraph. Structure, numbers and platforms stay deterministic.
 */
export const ADS_AGENT_KEY = "ads_manager" as const;

export const AD_PLAN_PLATFORMS: AdPlanPlatform[] = ["META_ADS", "GOOGLE_ADS", "TIKTOK"];

export const FORECAST_DISCLAIMER_AR =
  "هذه أرقام تقديرية مبنية على متوسطات سوقية تقريبية للسوق العراقي، وليست نتائج مضمونة. الأداء الفعلي يختلف حسب المنتج والإعلان والمنافسة والموسم.";

export const FORECAST_DISCLAIMER_EN =
  "These figures are conservative estimates based on rough Iraqi-market averages, not guaranteed results. Actual performance depends on the offer, the creative, competition and season.";

export const PLAN_DISCLAIMER_AR =
  "هذه خطة استشارية داخل أفق. لا يتصل النظام بـ Meta أو Google أو TikTok، ولا يُطلق حملة ولا يوقفها ولا ينفق أي مبلغ. الاعتماد قرار المالك، والتنفيذ يتم يدويًا خارج المنصة.";

export const PLAN_DISCLAIMER_EN =
  "This is advisory guidance inside Ofoq. The platform does not connect to Meta, Google or TikTok, does not launch or pause campaigns, and does not spend money. Approval is the owner's decision; any live execution happens manually outside the platform.";

const CATEGORY_SPLIT: Record<AdBusinessCategory, Record<AdPlanPlatform, number>> = {
  LOCAL_RETAIL: { META_ADS: 55, TIKTOK: 30, GOOGLE_ADS: 15 },
  RESTAURANT: { META_ADS: 50, TIKTOK: 35, GOOGLE_ADS: 15 },
  SERVICES: { META_ADS: 45, GOOGLE_ADS: 40, TIKTOK: 15 },
  PROFESSIONAL: { GOOGLE_ADS: 55, META_ADS: 45, TIKTOK: 0 },
  ECOMMERCE: { META_ADS: 40, GOOGLE_ADS: 35, TIKTOK: 25 },
  CONTENT: { TIKTOK: 50, META_ADS: 40, GOOGLE_ADS: 10 },
  REAL_ESTATE: { META_ADS: 50, GOOGLE_ADS: 35, TIKTOK: 15 },
  EDUCATION: { META_ADS: 40, GOOGLE_ADS: 35, TIKTOK: 25 },
  HEALTH: { GOOGLE_ADS: 50, META_ADS: 50, TIKTOK: 0 },
  OTHER: { META_ADS: 50, GOOGLE_ADS: 30, TIKTOK: 20 },
};

const DEFAULT_GEO = ["العراق", "بغداد", "البصرة", "أربيل", "النجف", "كربلاء", "الموصل"];

const PLATFORM_RATIONALE_AR: Record<AdPlanPlatform, string> = {
  META_ADS: "فيسبوك وإنستغرام هما القناة الأساسية لمعظم الأنشطة العراقية، والتحويل غالبًا عبر واتساب.",
  GOOGLE_ADS: "البحث في جوجل يصل لمن يبحث الآن عن الخدمة أو المنتج، وهو أنسب للنية الشرائية العالية.",
  TIKTOK: "تيك توك يناسب الجمهور الأصغر والمحتوى القصير، ويُستخدم لاكتشاف العلامة لا للبحث المباشر.",
};

export interface AdsBrief {
  businessCategory: AdBusinessCategory;
  objective: AdObjective;
  brief: string;
  audience?: string | null;
  geo?: string[] | null;
  totalBudgetMinor: number;
  durationDays: number;
  preferredPlatforms?: AdPlanPlatform[] | null;
  locale: Locale;
  brandName?: string | null;
  city?: string | null;
  country?: string | null;
}

/**
 * Splits a total USD budget across platforms so the cents sum exactly to the
 * total, and the daily cents sum exactly to the daily budget.
 */
export function splitBudgetAcrossPlatforms(
  totalMinor: number,
  days: number,
  percents: { platform: AdPlanPlatform; percent: number }[],
): { dailyBudgetMinor: number; allocations: AdPlatformAllocation[] } {
  const safeDays = Math.max(1, Math.round(days));
  const safeTotal = Math.max(0, Math.round(totalMinor));
  const dailyBudgetMinor = safeTotal === 0 ? 0 : Math.max(1, Math.round(safeTotal / safeDays));

  const active = percents.filter((entry) => entry.percent > 0);
  if (active.length === 0) {
    return { dailyBudgetMinor, allocations: [] };
  }

  const allocations: AdPlatformAllocation[] = [];
  let assignedTotal = 0;
  let assignedDaily = 0;
  for (let index = 0; index < active.length; index += 1) {
    const entry = active[index]!;
    const isLast = index === active.length - 1;
    const totalShare = isLast ? safeTotal - assignedTotal : Math.round((safeTotal * entry.percent) / 100);
    const dailyShare = isLast ? dailyBudgetMinor - assignedDaily : Math.round((dailyBudgetMinor * entry.percent) / 100);
    assignedTotal += totalShare;
    assignedDaily += dailyShare;
    allocations.push({
      platform: entry.platform,
      percent: entry.percent,
      totalBudgetMinor: Math.max(0, totalShare),
      dailyBudgetMinor: Math.max(0, dailyShare),
      rationale: PLATFORM_RATIONALE_AR[entry.platform],
    });
  }
  return { dailyBudgetMinor, allocations };
}

export function recommendPlatformPercents(
  category: AdBusinessCategory,
  preferred?: AdPlanPlatform[] | null,
): { platform: AdPlanPlatform; percent: number }[] {
  const base = CATEGORY_SPLIT[category] ?? CATEGORY_SPLIT.OTHER;
  const allowed = preferred?.length
    ? AD_PLAN_PLATFORMS.filter((platform) => preferred.includes(platform))
    : AD_PLAN_PLATFORMS.filter((platform) => (base[platform] ?? 0) > 0);
  const usable = allowed.length ? allowed : AD_PLAN_PLATFORMS.filter((platform) => (base[platform] ?? 0) > 0);
  const weights = usable.map((platform) => ({ platform, weight: Math.max(1, base[platform] ?? 0) }));
  const weightSum = weights.reduce((total, entry) => total + entry.weight, 0);
  let assigned = 0;
  return weights.map((entry, index) => {
    const isLast = index === weights.length - 1;
    const percent = isLast ? 100 - assigned : Math.round((entry.weight / weightSum) * 100);
    assigned += percent;
    return { platform: entry.platform, percent };
  });
}

/** Conservative Iraqi-market ranges used only for labelled estimates. */
const PLATFORM_RANGES: Record<
  AdPlanPlatform,
  { cpmLow: number; cpmHigh: number; ctrLow: number; ctrHigh: number; msgRate: number; orderRate: number }
> = {
  META_ADS: { cpmLow: 1.5, cpmHigh: 4, ctrLow: 0.008, ctrHigh: 0.02, msgRate: 0.08, orderRate: 0.015 },
  GOOGLE_ADS: { cpmLow: 4, cpmHigh: 10, ctrLow: 0.02, ctrHigh: 0.05, msgRate: 0.04, orderRate: 0.03 },
  TIKTOK: { cpmLow: 1, cpmHigh: 3, ctrLow: 0.006, ctrHigh: 0.015, msgRate: 0.05, orderRate: 0.01 },
};

export function buildForecasts(allocations: AdPlatformAllocation[], objective: AdObjective): AdForecasts {
  const platforms: AdPlatformForecast[] = allocations.map((allocation) => {
    const range = PLATFORM_RANGES[allocation.platform];
    const spend = allocation.totalBudgetMinor / 100;
    const impressionsHigh = range.cpmLow > 0 ? Math.round((spend / range.cpmLow) * 1000) : 0;
    const impressionsLow = range.cpmHigh > 0 ? Math.round((spend / range.cpmHigh) * 1000) : 0;
    const clicksLow = Math.round(impressionsLow * range.ctrLow);
    const clicksHigh = Math.round(impressionsHigh * range.ctrHigh);
    const messageFactor = objective === "MESSAGES" || objective === "LEADS" ? 1 : 0.4;
    const orderFactor = objective === "SALES" ? 1 : objective === "LEADS" ? 0.4 : 0.15;
    const messagesLow = Math.round(clicksLow * range.msgRate * messageFactor);
    const messagesHigh = Math.round(clicksHigh * range.msgRate * messageFactor);
    const ordersLow = Math.round(clicksLow * range.orderRate * orderFactor);
    const ordersHigh = Math.round(clicksHigh * range.orderRate * orderFactor);
    const cpcLowMinor = clicksHigh > 0 ? Math.round(allocation.totalBudgetMinor / clicksHigh) : 0;
    const cpcHighMinor = clicksLow > 0 ? Math.round(allocation.totalBudgetMinor / clicksLow) : 0;
    return {
      platform: allocation.platform,
      impressionsLow,
      impressionsHigh,
      clicksLow,
      clicksHigh,
      messagesLow,
      messagesHigh,
      ordersLow,
      ordersHigh,
      cpcLowMinor,
      cpcHighMinor,
    };
  });

  const totals = platforms.reduce(
    (accumulator, row) => ({
      impressionsLow: accumulator.impressionsLow + row.impressionsLow,
      impressionsHigh: accumulator.impressionsHigh + row.impressionsHigh,
      clicksLow: accumulator.clicksLow + row.clicksLow,
      clicksHigh: accumulator.clicksHigh + row.clicksHigh,
      messagesLow: accumulator.messagesLow + row.messagesLow,
      messagesHigh: accumulator.messagesHigh + row.messagesHigh,
      ordersLow: accumulator.ordersLow + row.ordersLow,
      ordersHigh: accumulator.ordersHigh + row.ordersHigh,
    }),
    {
      impressionsLow: 0,
      impressionsHigh: 0,
      clicksLow: 0,
      clicksHigh: 0,
      messagesLow: 0,
      messagesHigh: 0,
      ordersLow: 0,
      ordersHigh: 0,
    },
  );

  return {
    isEstimate: true,
    disclaimerAr: FORECAST_DISCLAIMER_AR,
    disclaimerEn: FORECAST_DISCLAIMER_EN,
    platforms,
    totals,
  };
}

function defaultAudience(brief: AdsBrief): AdAudience {
  const geo = (brief.geo?.filter((value) => value.trim()) ?? []).length
    ? brief.geo!.map((value) => value.trim())
    : brief.city
      ? ["العراق", brief.city]
      : DEFAULT_GEO;
  const description =
    brief.audience?.trim() ||
    (brief.locale === "ar"
      ? "جمهور داخل العراق مهتم بالنشاط، مع تركيز على من يتفاعل أو يبحث عن الخدمة."
      : "People in Iraq interested in the business, with a focus on those already engaging or searching.");
  return {
    description,
    geo,
    ageMin: 18,
    ageMax: brief.businessCategory === "CONTENT" || brief.businessCategory === "EDUCATION" ? 34 : 55,
    interests: interestsFor(brief.businessCategory),
    rationale:
      brief.locale === "ar"
        ? "الاستهداف يبدأ من السوق العراقي الجغرافي ثم الاهتمامات المرتبطة بالنشاط، مع إعادة استهداف من زار الصفحة أو راسل واتساب."
        : "Start with Iraqi geography, then in-market interests, and retarget page visitors or WhatsApp contacts.",
  };
}

function interestsFor(category: AdBusinessCategory): string[] {
  switch (category) {
    case "RESTAURANT":
      return ["مطاعم", "توصيل طعام", "عروض محلية"];
    case "LOCAL_RETAIL":
      return ["تسوق محلي", "عروض", "موضة"];
    case "ECOMMERCE":
      return ["تسوق أونلاين", "عروض", "توصيل"];
    case "REAL_ESTATE":
      return ["عقارات", "شقق للبيع", "استثمار عقاري"];
    case "HEALTH":
      return ["صحة", "عيادات", "تجميل"];
    case "EDUCATION":
      return ["دورات", "تعليم", "تطوير مهني"];
    case "PROFESSIONAL":
      return ["خدمات مهنية", "شركات", "استشارات"];
    case "CONTENT":
      return ["ترفيه", "محتوى قصير", "مشاهير محليون"];
    case "SERVICES":
      return ["خدمات محلية", "صيانة", "حرف"];
    default:
      return ["اهتمامات عامة مرتبطة بالنشاط"];
  }
}

function ideasFor(brief: AdsBrief, brand: string): AdIdea[] {
  const name = brand || "النشاط";
  return [
    {
      title: `فيديو قصير يعرّف ${name} خلال 15 ثانية`,
      format: "Reel / TikTok / Story",
      description: "لقطة واضحة للمنتج أو المكان، ثم جملة فائدة واحدة، ثم طلب واضح: راسل واتساب أو اطلب الآن.",
    },
    {
      title: "إعلان صورة قبل/بعد أو عرض الأسبوع",
      format: "Feed image",
      description: "صورة واحدة عالية الوضوح مع سعر أو عرض مكتوب داخل التصميم، باللهجة المفهومة في العراق.",
    },
    {
      title: "إعلان رسائل واتساب",
      format: "Click-to-WhatsApp",
      description: "الزر يفتح واتساب بسؤال جاهز. مناسب للسوق العراقي حيث التحويل يتم بالمحادثة لا بالنموذج الطويل.",
    },
  ];
}

function copyFor(brief: AdsBrief, brand: string, platforms: AdPlanPlatform[]): AdCopyBlock[] {
  const name = brand || "نشاطك";
  const byObjective: Record<AdObjective, { headline: string; text: string; cta: string }> = {
    AWARENESS: {
      headline: `${name} — صار أقرب لك`,
      text: `تعرف على ${name} من قلب العراق: شغل واضح، ومتابعة ترد عليك. شوف العمل واحكم بنفسك.`,
      cta: "تعرّف علينا",
    },
    TRAFFIC: {
      headline: `${name} — ادخل شوف التفاصيل`,
      text: `كل اللي تحتاجه بمكان واحد: الأسعار، الأمثلة، وطريقة الطلب. ادخل الصفحة وقرر براحتك.`,
      cta: "زور الصفحة",
    },
    ENGAGEMENT: {
      headline: `${name} يسألكم: شنو رأيكم؟`,
      text: `شاركونا رأيكم، احفظوا المنشور، وخلّوا اللي يحتاج يعرف. تواجد يومي ومتابعة للتعليقات.`,
      cta: "تفاعل معنا",
    },
    MESSAGES: {
      headline: `${name} — راسلنا واتساب هسة`,
      text: `جاوبك خلال ساعات الدوام، نوضح السعر والوقت بدون لف. اكتب «مرحبا» ونبدأ.`,
      cta: "راسل واتساب",
    },
    LEADS: {
      headline: `${name} — احجز استشارتك`,
      text: `خطوة واحدة: أرسل اسمك واحتياجك على واتساب ونرتب لك موعدًا واضحًا. بدون نماذج طويلة.`,
      cta: "اطلب استشارة",
    },
    SALES: {
      headline: `${name} — اطلب اليوم، توصيل داخل العراق`,
      text: `عرض واضح وسعر بالدولار أو ما يعادله، وتأكيد الطلب عبر واتساب. الكمية محدودة هذا الأسبوع.`,
      cta: "اطلب الآن",
    },
  };
  const pack = byObjective[brief.objective];
  return platforms.map((platform) => ({
    platform,
    headline: pack.headline,
    primaryText: pack.text,
    cta: pack.cta,
  }));
}

function kpisFor(objective: AdObjective): AdKpi[] {
  const shared: AdKpi[] = [
    {
      key: "spend",
      labelAr: "الإنفاق",
      labelEn: "Spend",
      target: null,
      rationale: "المبلغ المصروف فعليًا من الميزانية المتفق عليها، بالدولار.",
    },
    {
      key: "impressions",
      labelAr: "مرات الظهور",
      labelEn: "Impressions",
      target: null,
      rationale: "كم مرة ظهر الإعلان. رقم الظهور وحده لا يعني نجاحًا.",
    },
    {
      key: "clicks",
      labelAr: "النقرات",
      labelEn: "Clicks",
      target: null,
      rationale: "كم شخص ضغط على الإعلان.",
    },
    {
      key: "ctr",
      labelAr: "نسبة النقر (CTR)",
      labelEn: "CTR",
      target: "0.8%–2%",
      rationale: "من كل 100 ظهور، كم شخص ضغط. الأعلى أفضل عادة.",
    },
    {
      key: "cpc",
      labelAr: "تكلفة النقرة (CPC)",
      labelEn: "CPC",
      target: null,
      rationale: "متوسط ما دُفع لكل نقرة.",
    },
  ];
  if (objective === "MESSAGES" || objective === "LEADS" || objective === "SALES") {
    shared.push({
      key: "messages",
      labelAr: "الرسائل",
      labelEn: "Messages",
      target: null,
      rationale: "محادثات واتساب أو رسائل الصفحة — المؤشر الأقرب للسوق العراقي.",
    });
  }
  if (objective === "SALES" || objective === "LEADS") {
    shared.push({
      key: "orders",
      labelAr: "الطلبات / التحويلات",
      labelEn: "Orders / conversions",
      target: null,
      rationale: "عدد الطلبات أو الحجوزات المسجّلة يدويًا. لا يُختلق إن لم يُدخل.",
    });
    shared.push({
      key: "cpa",
      labelAr: "تكلفة النتيجة (CPA)",
      labelEn: "CPA",
      target: null,
      rationale: "الإنفاق مقسومًا على عدد الطلبات أو الرسائل حسب الهدف.",
    });
  }
  return shared;
}

function analysisFor(brief: AdsBrief, allocations: AdPlatformAllocation[]): AdPlanBody["analysis"] {
  const platformList = allocations.map((row) => row.platform.replace("_", " ")).join("، ");
  return {
    business:
      brief.brief.trim() ||
      `نشاط ضمن فئة ${brief.businessCategory} في السوق العراقي، والهدف الإعلاني هو ${brief.objective}.`,
    audience: defaultAudience(brief).description,
    platformRationale: `المنصات المقترحة (${platformList}) وُزعت حسب طبيعة النشاط في العراق: ميتا للتواجد المحلي وواتساب، جوجل لمن يبحث الآن، وتيك توك للاكتشاف البصري. التوزيع قابل للتعديل من المالك قبل الاعتماد.`,
  };
}

export function buildAdPlanDocument(brief: AdsBrief): { body: AdPlanBody; forecasts: AdForecasts } {
  const durationDays = Math.max(1, Math.round(brief.durationDays));
  const totalBudgetMinor = Math.max(0, Math.round(brief.totalBudgetMinor));
  const percents = recommendPlatformPercents(brief.businessCategory, brief.preferredPlatforms);
  const { dailyBudgetMinor, allocations } = splitBudgetAcrossPlatforms(totalBudgetMinor, durationDays, percents);
  const brand = brief.brandName?.trim() || null;
  const audience = defaultAudience(brief);
  const platforms = allocations.map((row) => row.platform);
  const body: AdPlanBody = {
    brief: brief.brief.trim(),
    businessCategory: brief.businessCategory,
    objective: brief.objective,
    audience,
    platforms: allocations,
    durationDays,
    dailyBudgetMinor,
    totalBudgetMinor,
    currency: "USD",
    adIdeas: ideasFor(brief, brand ?? "النشاط"),
    adCopy: copyFor(brief, brand ?? "نشاطك", platforms),
    kpis: kpisFor(brief.objective),
    analysis: analysisFor(brief, allocations),
    disclaimerAr: PLAN_DISCLAIMER_AR,
    disclaimerEn: PLAN_DISCLAIMER_EN,
  };
  return { body, forecasts: buildForecasts(allocations, brief.objective) };
}

export function summariseAdPlan(body: AdPlanBody, locale: Locale): string {
  const platforms = body.platforms.map((row) => `${row.platform.replaceAll("_", " ")} ${row.percent}%`).join(" · ");
  const money = formatMoney(body.totalBudgetMinor, "USD", locale);
  const daily = formatMoney(body.dailyBudgetMinor, "USD", locale);
  return locale === "ar"
    ? `خطة إعلانية استشارية لـ ${body.durationDays} يومًا بميزانية ${money} (يومي ${daily}) على: ${platforms}. بانتظار اعتماد المالك. الأرقام تقديرية وغير مضمونة.`
    : `An advisory ads plan for ${body.durationDays} days, budget ${money} (daily ${daily}), on: ${platforms}. Waiting for owner approval. Figures are estimates, not guarantees.`;
}

async function polishCopy(body: AdPlanBody, locale: Locale): Promise<AdPlanBody> {
  const status = aiStatus();
  if (!status.available) return body;
  try {
    const { aiComplete } = await import("@/lib/ai/provider");
    const seed = body.adCopy.map((block) => `${block.platform}: ${block.headline} — ${block.primaryText}`).join("\n");
    const result = await aiComplete({
      messages: [
        {
          role: "system",
          content:
            locale === "ar"
              ? "أنت كاتب إعلانات لوكالة عراقية. حسّن النصوص المعطاة بلغة عربية واضحة مفهومة في العراق (فصحى مبسطة مع لمسة محلية خفيفة). لا تخترع أسعارًا أو ضمانات أو أرقامًا. أعد نفس عدد النصوص، كل سطر: منصة | عنوان | نص | دعوة."
              : "You write ads for an Iraqi agency. Improve the given copy in clear Arabic understood in Iraq. Never invent prices, guarantees or numbers. Return the same number of lines: platform | headline | text | cta.",
        },
        { role: "user", content: seed },
      ],
      temperature: 0.4,
      maxTokens: 400,
    });
    const lines = result.text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length < body.adCopy.length) return body;
    const polished = body.adCopy.map((block, index) => {
      const parts = lines[index]?.split("|").map((part) => part.trim()) ?? [];
      if (parts.length < 4) return block;
      return {
        ...block,
        headline: parts[1] || block.headline,
        primaryText: parts[2] || block.primaryText,
        cta: parts[3] || block.cta,
      };
    });
    return { ...body, adCopy: polished };
  } catch {
    return body;
  }
}

export interface ProposeAdPlanInput extends AdsBrief {
  customerId: string;
  projectId?: string | null;
  actorUserId?: string | null;
}

export interface ProposeAdPlanDraft {
  body: AdPlanBody;
  forecasts: AdForecasts;
  summary: string;
  status: "DRAFT";
  requiresOwnerApproval: true;
}

/**
 * Builds the draft document. Persistence is the service layer's job so the
 * agent cannot approve, launch or spend.
 */
export async function proposeAdPlanDraft(input: ProposeAdPlanInput): Promise<ProposeAdPlanDraft> {
  const built = buildAdPlanDocument(input);
  const body = await polishCopy(built.body, input.locale);
  const summary = summariseAdPlan(body, input.locale);

  await runAgent(
    ADS_AGENT_KEY,
    {
      trigger: "ads.plan_requested",
      locale: input.locale,
      customerId: input.customerId,
      projectId: input.projectId ?? null,
      actorUserId: input.actorUserId ?? null,
      input: {
        objective: input.objective,
        category: input.businessCategory,
        totalBudgetMinor: input.totalBudgetMinor,
        days: input.durationDays,
      },
    },
    async ({ record }) => {
      record({
        action: "ad_plan.proposed",
        summary: `اقترح وكيل الإعلانات خطة استشارية بميزانية ${formatMoney(body.totalBudgetMinor, "USD", "ar")} — بانتظار مراجعة المالك واعتمادها. لا إطلاق ولا إنفاق.`,
        reason: "advisory_only",
        entityType: "ad_plan",
        entityId: null,
        customerId: input.customerId,
        riskLevel: "MEDIUM",
        requiresApproval: true,
        payload: {
          platforms: body.platforms.map((row) => ({ platform: row.platform, percent: row.percent })),
          totalBudgetMinor: body.totalBudgetMinor,
          dailyBudgetMinor: body.dailyBudgetMinor,
          durationDays: body.durationDays,
          liveExecution: false,
        },
      });
      return {
        data: { totalBudgetMinor: body.totalBudgetMinor, platforms: body.platforms.length },
        summary: "خطة إعلانية مسودة — بانتظار اعتماد المالك",
        riskLevel: "MEDIUM",
      };
    },
  );

  return { body, forecasts: built.forecasts, summary, status: "DRAFT", requiresOwnerApproval: true };
}

export interface AdKpiActuals {
  spendMinor: number;
  impressions: number;
  clicks: number;
  messages: number;
  orders: number;
  ctr: number | null;
  cpcMinor: number | null;
  cpmMinor: number | null;
  costPerMessageMinor: number | null;
  cpaMinor: number | null;
}

export function computeAdKpis(results: AdPlanResultRow[]): AdKpiActuals {
  const totals = results.reduce(
    (accumulator, row) => ({
      spendMinor: accumulator.spendMinor + row.spend_minor,
      impressions: accumulator.impressions + row.impressions,
      clicks: accumulator.clicks + row.clicks,
      messages: accumulator.messages + row.messages,
      orders: accumulator.orders + row.orders,
    }),
    { spendMinor: 0, impressions: 0, clicks: 0, messages: 0, orders: 0 },
  );
  return {
    ...totals,
    ctr: totals.impressions > 0 ? Number(((totals.clicks / totals.impressions) * 100).toFixed(4)) : null,
    cpcMinor: totals.clicks > 0 ? Math.round(totals.spendMinor / totals.clicks) : null,
    cpmMinor: totals.impressions > 0 ? Math.round((totals.spendMinor / totals.impressions) * 1000) : null,
    costPerMessageMinor: totals.messages > 0 ? Math.round(totals.spendMinor / totals.messages) : null,
    cpaMinor: totals.orders > 0 ? Math.round(totals.spendMinor / totals.orders) : null,
  };
}

export interface AdRecommendation {
  key: string;
  titleAr: string;
  titleEn: string;
  detailAr: string;
  detailEn: string;
  suggestedSplit?: { platform: AdPlanPlatform; percent: number }[];
}

export function recommendImprovements(body: AdPlanBody, kpis: AdKpiActuals): AdRecommendation[] {
  const recommendations: AdRecommendation[] = [];
  if (kpis.impressions === 0 && kpis.spendMinor === 0) {
    recommendations.push({
      key: "no_data",
      titleAr: "لا توجد نتائج مُدخلة بعد",
      titleEn: "No results have been entered yet",
      detailAr: "أدخل الإنفاق والمشاهدات والنقرات يدويًا قبل اقتراح أي تعديل. النظام لا يختلق أرقامًا.",
      detailEn: "Enter spend, impressions and clicks manually before any change is suggested. The system never invents numbers.",
    });
    return recommendations;
  }
  if (kpis.impressions >= 1000 && (kpis.ctr ?? 0) < 0.6) {
    recommendations.push({
      key: "low_ctr",
      titleAr: "نسبة النقر منخفضة",
      titleEn: "Click-through rate is low",
      detailAr: "جرّب نصًا أوضح يبدأ بالفائدة، وصورة أقرب لجمهورك العراقي، ودعوة واحدة فقط (واتساب).",
      detailEn: "Try clearer copy that leads with one benefit, a more local creative, and a single WhatsApp call to action.",
    });
  }
  if (kpis.spendMinor > 0 && kpis.clicks === 0) {
    recommendations.push({
      key: "no_clicks",
      titleAr: "إنفاق بلا نقرات",
      titleEn: "Spend with no clicks",
      detailAr: "أوقف التوسيع وأعد صياغة العنوان. لا نرفع الميزانية تلقائيًا.",
      detailEn: "Stop broadening the audience and rewrite the headline. The budget is never raised automatically.",
    });
  }
  if ((body.objective === "MESSAGES" || body.objective === "LEADS") && kpis.clicks >= 20 && kpis.messages === 0) {
    recommendations.push({
      key: "no_messages",
      titleAr: "نقرات بلا رسائل",
      titleEn: "Clicks with no messages",
      detailAr: "حوّل الدعوة إلى واتساب مباشر وسهّل أول رسالة (اكتب: سعر؟).",
      detailEn: "Switch the call to action to WhatsApp and make the first message effortless.",
    });
  }
  if (body.platforms.length > 1 && kpis.spendMinor > 0) {
    const weakest = body.platforms.slice().sort((a, b) => a.percent - b.percent)[0];
    if (weakest && weakest.percent >= 15 && (kpis.ctr ?? 1) < 0.8) {
      const suggested = body.platforms.map((row) => ({
        platform: row.platform,
        percent: row.platform === weakest.platform ? Math.max(10, row.percent - 10) : row.percent,
      }));
      const remainder = 100 - suggested.reduce((total, row) => total + row.percent, 0);
      if (suggested[0]) suggested[0] = { ...suggested[0], percent: suggested[0].percent + remainder };
      recommendations.push({
        key: "rebalance",
        titleAr: "إعادة توزيع مقترحة للميزانية",
        titleEn: "Suggested budget rebalance",
        detailAr: "اقتراح فقط: تقليل الحصة الأضعف لصالح المنصة الأساسية. لا يُطبَّق إلا في مسودة جديدة وبعد اعتماد المالك.",
        detailEn: "Suggestion only: shift budget away from the weaker platform. Nothing is applied except as a new draft after the owner approves.",
        suggestedSplit: suggested,
      });
    }
  }
  if (recommendations.length === 0) {
    recommendations.push({
      key: "hold",
      titleAr: "الاستمرار مع مراقبة أسبوعية",
      titleEn: "Keep going, review weekly",
      detailAr: "المؤشرات ضمن مدى مقبول مبدئيًا. لا تغيير للخطة المعتمدة. أعد إدخال النتائج أسبوعيًا.",
      detailEn: "The indicators look acceptable so far. The approved plan is not changed. Enter results weekly.",
    });
  }
  return recommendations;
}

export function applySuggestedSplit(body: AdPlanBody, split: { platform: AdPlanPlatform; percent: number }[]): AdPlanBody {
  const { dailyBudgetMinor, allocations } = splitBudgetAcrossPlatforms(
    body.totalBudgetMinor,
    body.durationDays,
    split,
  );
  return {
    ...body,
    dailyBudgetMinor,
    platforms: allocations.map((row) => ({
      ...row,
      rationale: `${row.rationale} (توزيع مقترح بعد قراءة النتائج — مسودة فقط).`,
    })),
  };
}

export function describeAdsBoundaries(locale: Locale): string {
  return locale === "ar" ? PLAN_DISCLAIMER_AR : PLAN_DISCLAIMER_EN;
}

export function usdToMinor(amount: number): number {
  return toMinor(amount, "USD");
}
