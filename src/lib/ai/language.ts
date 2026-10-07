import type { Locale } from "@/lib/domain/types";

/**
 * Language handling.
 *
 * The platform is bilingual (Arabic/English). Detection is script-based and
 * deterministic; it runs on every inbound message so the assistant replies in
 * the client's language without asking, while the client can always switch the
 * interface language manually (see the locale cookie).
 *
 * Arabic output rules: clear Modern Standard Arabic ("white Arabic") — simple,
 * friendly, no strong local dialect and no convoluted classical constructions.
 */

const ARABIC_PATTERN = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/;
const LATIN_PATTERN = /[A-Za-z]/;

export type DetectedLanguage = "ar" | "en" | "unknown";

export function detectLanguage(text: string | null | undefined): DetectedLanguage {
  if (!text) return "unknown";
  const arabic = (text.match(/[\u0600-\u06FF]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  if (arabic === 0 && latin === 0) return "unknown";
  if (arabic >= latin) return "ar";
  return "en";
}

/** Resolves the reply language: detected language first, then the fallback. */
export function resolveLocale(
  text: string | null | undefined,
  fallback: Locale = "ar",
): Locale {
  const detected = detectLanguage(text);
  if (detected === "ar" || detected === "en") return detected;
  return fallback;
}

export function isArabic(text: string | null | undefined): boolean {
  return detectLanguage(text) === "ar";
}

/**
 * Bilingual message catalogue for assistant replies.
 *
 * Only user-facing assistant strings live here; UI copy lives in
 * `src/lib/i18n/*`, and reports build their own text.
 */
export const assistantCopy = {
  greeting: {
    ar: "أهلًا بك في أفق 👋\nأنا مساعد أفق، مساعد ذكي تابع للوكالة. أخبرني عن مشروعك وسأساعدك خطوة بخطوة.",
    en: "Welcome to Ofoq 👋\nI'm the Ofoq assistant, an AI assistant that works with the agency. Tell me about your project and I'll guide you step by step.",
  },
  assistantDisclosure: {
    ar: "تنبيه: أنا مساعد ذكي تابع لوكالة أفق، ولست شخصًا. يمكنك دائمًا طلب التواصل مع فريق بشري.",
    en: "Note: I'm an AI assistant that belongs to the Ofoq agency, not a person. You can always ask to speak with a human team member.",
  },
  askGoal: {
    ar: "ما الهدف الأساسي الذي تريد تحقيقه؟ مثلًا: زيادة متابعين، جلب طلبات، إطلاق متجر، أو تحسين ظهور موقعك.",
    en: "What is the main goal you want to achieve? For example: more followers, more leads, launching a store, or better search visibility.",
  },
  askService: {
    ar: "أي خدمة تناسبك أكثر؟ يمكنك اختيار واحدة أو أكثر:\n• إدارة حسابات التواصل الاجتماعي\n• كتابة وتصميم المنشورات\n• إدارة الإعلانات المدفوعة\n• تصميم الهوية والمواد التسويقية\n• إنشاء وتطوير موقع\n• تحسين محركات البحث (SEO)\n• تحليل الأداء والتقارير\n• استشارة وخطط تسويقية",
    en: "Which service fits you best? You can choose one or more:\n• Social media management\n• Post writing and design\n• Paid ads management\n• Branding and marketing materials\n• Website creation and development\n• SEO\n• Performance analysis and reporting\n• Consulting and marketing plans",
  },
  askPlatforms: {
    ar: "على أي منصات تريد العمل؟ (إنستغرام، فيسبوك، تيك توك، إكس، لينكد إن، يوتيوب، أو غيرها)",
    en: "Which platforms should we cover? (Instagram, Facebook, TikTok, X, LinkedIn, YouTube, or others)",
  },
  askVolume: {
    ar: "كم عدد المنشورات أو المواد التي تحتاجها في الشهر؟ (مثال: ١٢ منشورًا، أو ٤ تصاميم)",
    en: "How many posts or items do you need per month? (for example: 12 posts, or 4 designs)",
  },
  askTimeline: {
    ar: "متى تريد أن يبدأ العمل؟ وهل هناك موعد نهائي محدد؟",
    en: "When would you like to start, and is there a specific deadline?",
  },
  askBudget: {
    ar: "ما الميزانية التقريبية التي تضعها في ذهنك؟ إن لم تكن متأكدًا، اكتب «غير محدد» وسأقترح سعرًا مناسبًا.",
    en: "What budget range do you have in mind? If you are not sure, write \"not sure\" and I'll suggest a fair price.",
  },
  askCountry: {
    ar: "من أي بلد تتابع عملنا؟ ولمعرفة العملة المناسبة، هل تفضل الدولار أم عملتك المحلية؟",
    en: "Which country are you based in? And would you prefer USD or your local currency?",
  },
  askMarket: {
    ar: "من هم عملاؤك المستهدفون؟ ومن أي بلد أو منطقة؟",
    en: "Who are your target customers, and in which country or region?",
  },
  summaryIntro: {
    ar: "هذا ملخص ما فهمته منك:",
    en: "Here is a summary of what I understood:",
  },
  noted: {
    ar: "ممتاز، سجّلت هذه المعلومة ✅",
    en: "Great, I've noted that ✅",
  },
  waitingReview: {
    ar: "سجّلت سؤالك، وفريقنا يراجع التفاصيل وسيرد عليك مباشرة. وحتى ذلك الحين، هذا ملخص ما فهمته:",
    en: "I've noted your question — our team is reviewing the details and will reply directly. In the meantime, here is the summary of what I understood:",
  },
  summaryConfirm: {
    ar: "هل الملخص صحيح؟ اكتب «نعم» للمتابعة، أو أخبرني ما تريد تعديله.",
    en: "Is this summary correct? Write \"yes\" to continue, or tell me what to change.",
  },
  offerReady: {
    ar: "أعددت لك عرضًا مبدئيًا. يمكنك مراجعته ثم الموافقة عليه أو طلب تعديل.",
    en: "I have prepared an initial offer for you. Please review it and then approve it or request changes.",
  },
  thanks: {
    ar: "شكرًا لك! سيتابع فريقنا التنفيذ وأبلغك بكل تحديث أولًا بأول.",
    en: "Thank you! Our team will now take over delivery and I'll keep you updated at every step.",
  },
  fallback: {
    ar: "لم أفهم طلبك تمامًا. هل يمكنك توضيحه بكلمات أبسط؟ أو اختر أحد الخيارات التالية.",
    en: "I did not fully understand your request. Could you rephrase it simply? Or pick one of the options below.",
  },
  humanHandoff: {
    ar: "تم تنبيه الفريق، وسيتواصل معك أحد أعضاء فريق أفق قريبًا.",
    en: "The team has been notified and an Ofoq team member will contact you shortly.",
  },
  escalation: {
    ar: "طلبك يحتاج مراجعة من فريقنا لأنه خارج النطاق المعتاد. سأبلغ الفريق الآن وسنعود إليك بالتفاصيل.",
    en: "Your request needs a review by our team because it is outside the usual range. I'm notifying them now and we'll get back to you with details.",
  },
  deepReportOffer: {
    ar: "يمكنني إرسال تقرير مفصّل يشرح الأرقام والمصطلحات ببساطة. اكتب «تفاصيل أكثر» متى أردت.",
    en: "I can send a detailed report that explains the numbers and terms simply. Write \"more details\" whenever you want it.",
  },
  privacyNote: {
    ar: "لن أطلب منك أبدًا بيانات بطاقتك. الدفع يتم عبر قنوات الوكالة الرسمية داخل المنصة.",
    en: "I will never ask for your card details. Payments happen through the agency's official channels inside the platform.",
  },
} as const;

export type AssistantCopyKey = keyof typeof assistantCopy;

export function t(key: AssistantCopyKey, locale: Locale): string {
  return assistantCopy[key][locale];
}

/** Normalises Arabic-Indic digits to ASCII so numbers can be parsed reliably. */
export function normaliseDigits(input: string): string {
  return input
    .replace(/[\u0660-\u0669]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0));
}

export function formatNumber(value: number, locale: Locale): string {
  return new Intl.NumberFormat(locale === "ar" ? "ar-IQ" : "en-US", { maximumFractionDigits: 2 }).format(value);
}

/**
 * Bilingual keyword vocabulary used by the rules engine to understand requests
 * without a model provider. Kept intentionally plain and dialect-neutral.
 */
export const keywordVocabulary: Record<string, string[]> = {
  social_media_management: [
    "social media",
    "social",
    "accounts",
    "page",
    "instagram",
    "facebook",
    "tiktok",
    "إدارة حسابات",
    "سوشيال",
    "صفحة",
    "انستغرام",
    "إنستغرام",
    "فيسبوك",
    "تيك توك",
    "تواصل اجتماعي",
  ],
  content_design: [
    "post",
    "posts",
    "design",
    "content",
    "منشور",
    "منشورات",
    "تصميم",
    "تصاميم",
    "محتوى",
  ],
  content_strategy: [
    "content plan",
    "calendar",
    "strategy",
    "خطة نشر",
    "خطة محتوى",
    "استراتيجية",
    "خطة تسويقية",
  ],
  paid_ads: [
    "ads",
    "advertising",
    "campaign",
    "google ads",
    "meta ads",
    "إعلانات",
    "حملة",
    "إعلان",
    "مدفوع",
  ],
  branding: ["brand", "logo", "identity", "هوية", "شعار", "لوجو", "علامة تجارية"],
  web_development: [
    "website",
    "web",
    "landing page",
    "store",
    "shop",
    "موقع",
    "متجر",
    "صفحة هبوط",
    "متجر إلكتروني",
  ],
  seo: ["seo", "search", "ranking", "سيو", "محركات البحث", "ظهور", "ترتيب"],
  analytics_reports: ["report", "reports", "analytics", "تحليل", "تقارير", "تقرير", "أداء"],
  consulting: ["consult", "consulting", "advice", "استشارة", "استشارات", "نصيحة"],
};

/**
 * Human-readable labels for the vocabulary used across the product.
 *
 * The client must never see internal identifiers ("social-media-management"), and
 * staff surfaces read better with the same names. UIs and assistant copy both use
 * these helpers, so a rename happens in exactly one place.
 */
export const SERVICE_LABELS: Record<string, { ar: string; en: string }> = {
  "social-media-management": { ar: "إدارة حسابات التواصل الاجتماعي", en: "Social media management" },
  "content-design": { ar: "كتابة وتصميم المنشورات", en: "Post writing and design" },
  "content-strategy": { ar: "صناعة المحتوى وخطط النشر", en: "Content creation and publishing plans" },
  "paid-ads": { ar: "إدارة الإعلانات المدفوعة", en: "Paid ads management" },
  branding: { ar: "تصميم الهوية والمواد التسويقية", en: "Branding and marketing materials" },
  "web-development": { ar: "إنشاء وتطوير المواقع", en: "Website creation and development" },
  seo: { ar: "تحسين محركات البحث (SEO)", en: "Search engine optimisation (SEO)" },
  "analytics-reports": { ar: "تحليل الأداء والتقارير", en: "Performance analysis and reporting" },
  consulting: { ar: "الاستشارات والخطط التسويقية", en: "Consulting and marketing plans" },
};

export const PLATFORM_LABELS: Record<string, { ar: string; en: string }> = {
  instagram: { ar: "إنستغرام", en: "Instagram" },
  facebook: { ar: "فيسبوك", en: "Facebook" },
  tiktok: { ar: "تيك توك", en: "TikTok" },
  x: { ar: "إكس (تويتر)", en: "X (Twitter)" },
  linkedin: { ar: "لينكد إن", en: "LinkedIn" },
  youtube: { ar: "يوتيوب", en: "YouTube" },
  google_ads: { ar: "إعلانات جوجل", en: "Google Ads" },
  snapchat: { ar: "سناب شات", en: "Snapchat" },
};

export const SLOT_LABELS: Record<string, { ar: string; en: string }> = {
  goal: { ar: "الهدف", en: "Goal" },
  services: { ar: "الخدمات", en: "Services" },
  platforms: { ar: "المنصات", en: "Platforms" },
  volume: { ar: "الكمية", en: "Volume" },
  timeline: { ar: "الموعد", en: "Timeline" },
  budget: { ar: "الميزانية", en: "Budget" },
  market: { ar: "السوق", en: "Market" },
};

export function serviceLabel(slug: string, locale: Locale): string {
  const entry = SERVICE_LABELS[slug];
  if (entry) return locale === "ar" ? entry.ar : entry.en;
  // Unknown slug (a service added from the dashboard): fall back to a readable form.
  return slug.replace(/[-_]/g, " ");
}

export function platformLabel(key: string, locale: Locale): string {
  const entry = PLATFORM_LABELS[key];
  if (entry) return locale === "ar" ? entry.ar : entry.en;
  return key.replace(/[-_]/g, " ");
}

export function slotLabel(slot: string, locale: Locale): string {
  const entry = SLOT_LABELS[slot];
  if (entry) return locale === "ar" ? entry.ar : entry.en;
  return slot;
}

export function detectServiceHints(text: string): string[] {
  const haystack = text.toLowerCase();
  const matches: string[] = [];
  for (const [slug, keywords] of Object.entries(keywordVocabulary)) {
    if (keywords.some((keyword) => haystack.includes(keyword.toLowerCase()))) matches.push(slug);
  }
  return matches;
}

/**
 * Detects a budget expressed in the message, in major units.
 *
 * A bare number is NOT a budget: it is only treated as one when the message also
 * carries a currency token or an explicit budget word. This prevents "15 posts"
 * from being recorded as a 1500 budget.
 */
export function detectBudget(text: string): { min?: number; max?: number; currency?: string } | null {
  const normalised = normaliseDigits(text.toLowerCase());

  const currency = /iqd|دينار|د\.ع/.test(normalised)
    ? "IQD"
    : /usd|\$|dollar|دولار/.test(normalised)
      ? "USD"
      : /eur|€|euro|يورو/.test(normalised)
        ? "EUR"
        : /aed|درهم/.test(normalised)
          ? "AED"
          : /sar|ريال/.test(normalised)
            ? "SAR"
            : undefined;

  const budgetWords = /(ميزاني|budget|ميزانية|سأدفع|سادفع|أدفع|ادفع|تكلفة|cost|spend|مصروف|بحدود|حوالي|about|around)/;
  const hasBudgetContext = Boolean(currency) || budgetWords.test(normalised);
  if (!hasBudgetContext) return null;

  // Numbers only, so wording never leaks into the amount.
  const amounts = [...normalised.matchAll(/(\d+(?:[.,]\d+)?)\s*(k|ألف|الف|thousand)?/g)]
    .map((match) => {
      const base = Number((match[1] ?? "0").replace(/,/g, ""));
      const multiplier = match[2] ? 1_000 : 1;
      return Number.isFinite(base) ? base * multiplier : 0;
    })
    .filter((value) => value > 0);

  if (amounts.length === 0) return null;
  if (amounts.length === 1) {
    const only = amounts[0]!;
    // For "not sure" style answers with no numbers nothing is returned above.
    return { max: only, min: only, currency };
  }
  const sorted = [...amounts].sort((a, b) => a - b);
  return { min: sorted[0]!, max: sorted[sorted.length - 1]!, currency };
}

/**
 * Detects a deadline or delivery expectation mentioned by the client.
 * Understands Arabic duals and bare units ("أسبوعين", "شهر", "يومين") as well as
 * numeric forms in both languages.
 */
export function detectTimelineDays(text: string): number | null {
  const normalised = normaliseDigits(text.toLowerCase());

  const weekMatch = /(\d+)\s*(weeks?|أسابيع|اسبوع|أسبوع)/.exec(normalised);
  if (weekMatch) return Number(weekMatch[1]) * 7;
  const dayMatch = /(\d+)\s*(days?|أيام|ايام|يوم)/.exec(normalised);
  if (dayMatch) return Number(dayMatch[1]);
  const monthMatch = /(\d+)\s*(months?|أشهر|اشهر|شهر)/.exec(normalised);
  if (monthMatch) return Number(monthMatch[1]) * 30;

  // Arabic duals and unitless mentions.
  if (/أسبوعين|اسبوعين/.test(normalised)) return 14;
  if (/شهرين/.test(normalised)) return 60;
  if (/يومين/.test(normalised)) return 2;
  if (/أسبوع|اسبوع|week/.test(normalised)) return 7;
  if (/شهر|month/.test(normalised)) return 30;
  if (/سنة|year|annual|سنوي/.test(normalised)) return 365;

  if (/urgent|asap|عاجل|بأسرع|حالا|حالًا/.test(normalised)) return 7;
  if (/next month|الشهر القادم/.test(normalised)) return 30;
  return null;
}

export function detectPlatforms(text: string): string[] {
  const haystack = text.toLowerCase();
  const platforms: [string, string[]][] = [
    ["instagram", ["instagram", "انستغرام", "إنستغرام", "انستقرام", "ig"]],
    ["facebook", ["facebook", "فيسبوك", "فيس بوك", "fb"]],
    ["tiktok", ["tiktok", "تيك توك", "تيكتوك"]],
    ["x", ["twitter", "x.com", " تويتر", "إكس"]],
    ["linkedin", ["linkedin", "لينكد إن", "لينكدان"]],
    ["youtube", ["youtube", "يوتيوب"]],
    ["google_ads", ["google ads", "جوجل ادز", "إعلانات جوجل"]],
  ];
  return platforms
    .filter(([, keywords]) => keywords.some((keyword) => haystack.includes(keyword)))
    .map(([name]) => name);
}

export function detectPostCount(text: string): number | null {
  const normalised = normaliseDigits(text.toLowerCase());
  const match = /(\d+)\s*(posts?|منشور|منشورات|تصاميم|تصميم|materials?|مواد)/.exec(normalised);
  if (match) return Number(match[1]);
  return null;
}
