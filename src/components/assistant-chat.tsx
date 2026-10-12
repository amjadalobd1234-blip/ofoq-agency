"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

import {
  calculateServiceEstimate,
  formatCount,
  formatUsd,
  type BudgetBand,
  type PricingInput,
  type PricingServiceType,
  type TargetingArea,
} from "@/lib/agents/pricing-agent";
import type { Locale } from "@/lib/domain/types";
import { dictionaries } from "@/lib/i18n/dictionaries";

interface ChatMessage {
  id: string;
  sender: string;
  body: string;
  language: string;
  createdAt: string;
  /** Which engine wrote an assistant reply: "groq", "cohere", … or "rules". */
  provider?: string | null;
}

/**
 * A service request opened from the dashboard button (/chat?intent=service_request).
 * Kept in sessionStorage so a refresh in this tab continues the same request
 * instead of asking the first question again.
 */
interface ServiceRequestContext {
  intent: "service_request";
  conversationId: string;
  /** Last saved message when the request started: the welcome is shown right after it. */
  afterMessageId: string | null;
  startedAt: string;
  /** The question waiting for an answer, or SUMMARY once every question was answered. */
  step: ServiceRequestStep;
  /** Chosen option ids (language independent), e.g. { type: "design", size: "small" }. */
  answers: ServiceRequestAnswers;
  /** When each answer was given and which saved message was last at that moment, so the exchange stays in place. */
  answerLog: ServiceRequestAnswerEvent[];
}

export type ServiceRequestStep =
  | "TYPE"
  | "SIZE"
  | "PLATFORMS"
  | "DEADLINE"
  | "BUDGET"
  | "BUSINESS_TYPE"
  | "PRICE_RANGE"
  | "TARGETING"
  | "SUMMARY";
/** Every step except SUMMARY asks one question. */
export type ServiceRequestQuestionStep = Exclude<ServiceRequestStep, "SUMMARY">;
export type ServiceRequestAnswerKey = "type" | "size" | "platforms" | "deadline" | "budget" | "businessType" | "priceRange" | "targeting";
export type ServiceRequestAnswers = Partial<Record<ServiceRequestAnswerKey, string>>;

interface ServiceRequestAnswerEvent {
  step: ServiceRequestQuestionStep;
  afterMessageId: string | null;
  answeredAt: string;
}

interface ServiceRequestOption {
  id: string;
  label: Record<Locale, string>;
}

interface ServiceRequestQuestion {
  answerKey: ServiceRequestAnswerKey;
  question: Record<Locale, string>;
  options: ServiceRequestOption[];
}

export const SERVICE_REQUEST_STEPS: readonly ServiceRequestStep[] = [
  "TYPE",
  "SIZE",
  "PLATFORMS",
  "DEADLINE",
  "BUDGET",
  "BUSINESS_TYPE",
  "PRICE_RANGE",
  "TARGETING",
  "SUMMARY",
];

/** The guided questions of a service request, in order. Option ids are what gets stored; labels are what the client sees. */
export const SERVICE_REQUEST_QUESTIONS: Record<ServiceRequestQuestionStep, ServiceRequestQuestion> = {
  TYPE: {
    answerKey: "type",
    question: { ar: "شنو نوع الخدمة اللي تحتاجها؟", en: "What type of service do you need?" },
    options: [
      { id: "design", label: { ar: "تصميم", en: "Design" } },
      { id: "ads", label: { ar: "إعلانات", en: "Ads" } },
      { id: "social_media", label: { ar: "سوشيال ميديا", en: "Social media" } },
      { id: "content", label: { ar: "محتوى", en: "Content" } },
      { id: "seo", label: { ar: "SEO", en: "SEO" } },
      { id: "other", label: { ar: "غير ذلك", en: "Other" } },
    ],
  },
  SIZE: {
    answerKey: "size",
    question: { ar: "شكد حجم المشروع؟", en: "How big is the project?" },
    options: [
      { id: "small", label: { ar: "صغير", en: "Small" } },
      { id: "medium", label: { ar: "متوسط", en: "Medium" } },
      { id: "large", label: { ar: "كبير", en: "Large" } },
    ],
  },
  PLATFORMS: {
    answerKey: "platforms",
    question: { ar: "على أي منصات تريد نشتغل؟", en: "Which platforms should we work on?" },
    options: [
      { id: "instagram", label: { ar: "Instagram", en: "Instagram" } },
      { id: "tiktok", label: { ar: "TikTok", en: "TikTok" } },
      { id: "facebook", label: { ar: "Facebook", en: "Facebook" } },
      { id: "google", label: { ar: "Google", en: "Google" } },
      { id: "multiple", label: { ar: "متعدد", en: "Multiple" } },
    ],
  },
  DEADLINE: {
    answerKey: "deadline",
    question: { ar: "شكد وقت عندك للتسليم؟", en: "How much time do you have for delivery?" },
    options: [
      { id: "standard_7_days", label: { ar: "عادي (7 أيام)", en: "Standard (7 days)" } },
      { id: "urgent_3_days", label: { ar: "مستعجل (3 أيام)", en: "Urgent (3 days)" } },
      { id: "flexible_14_days", label: { ar: "مرن (14 يوم)", en: "Flexible (14 days)" } },
    ],
  },
  BUDGET: {
    answerKey: "budget",
    question: { ar: "شنو الميزانية التقريبية؟", en: "What is your approximate budget?" },
    options: [
      { id: "under_200", label: { ar: "أقل من 200$", en: "Under $200" } },
      { id: "200_500", label: { ar: "200-500$", en: "$200-500" } },
      { id: "500_1500", label: { ar: "500-1500$", en: "$500-1500" } },
      { id: "over_1500", label: { ar: "أكثر من 1500$", en: "Over $1500" } },
    ],
  },
  BUSINESS_TYPE: {
    answerKey: "businessType",
    question: { ar: "شنو نوع مشروعك؟", en: "What kind of business do you have?" },
    options: [
      { id: "online_store", label: { ar: "🛍️ متجر إلكتروني", en: "🛍️ Online store" } },
      { id: "local_store", label: { ar: "🏪 متجر محلي", en: "🏪 Local shop" } },
      { id: "restaurant", label: { ar: "🍽️ مطعم/مقهى", en: "🍽️ Restaurant/café" } },
      { id: "service", label: { ar: "💼 خدمة (استشارات، تعليم، تصميم)", en: "💼 Service (consulting, education, design)" } },
      { id: "real_estate", label: { ar: "🏗️ عقارات/سيارات", en: "🏗️ Real estate/cars" } },
      { id: "luxury", label: { ar: "💎 منتجات فاخرة", en: "💎 Luxury products" } },
      { id: "other", label: { ar: "🌐 شي ثاني", en: "🌐 Something else" } },
    ],
  },
  PRICE_RANGE: {
    answerKey: "priceRange",
    question: { ar: "شكد سعر منتجاتك تقريباً؟", en: "How much do your products usually cost?" },
    options: [
      { id: "under_50k", label: { ar: "أقل من 50,000 دينار", en: "Under IQD 50,000" } },
      { id: "50k_150k", label: { ar: "50,000 - 150,000", en: "IQD 50,000 - 150,000" } },
      { id: "150k_500k", label: { ar: "150,000 - 500,000", en: "IQD 150,000 - 500,000" } },
      { id: "over_500k", label: { ar: "أكثر من 500,000", en: "Over IQD 500,000" } },
    ],
  },
  TARGETING: {
    answerKey: "targeting",
    question: { ar: "وين تريد تستهدف إعلانك؟", en: "Where would you like to target your campaign?" },
    options: [
      { id: "iraq_all", label: { ar: "🇮🇶 العراق كله", en: "🇮🇶 All Iraq" } },
      { id: "baghdad", label: { ar: "🏙️ بغداد فقط", en: "🏙️ Baghdad only" } },
      { id: "basra", label: { ar: "🌊 البصرة فقط", en: "🌊 Basra only" } },
      { id: "three_cities", label: { ar: "🏙️ بغداد + البصرة + أربيل", en: "🏙️ Baghdad + Basra + Erbil" } },
      { id: "gulf", label: { ar: "🌍 الخليج (السعودية، الإمارات، الكويت)", en: "🌍 Gulf (Saudi Arabia, UAE, Kuwait)" } },
      { id: "arabic_global", label: { ar: "🌐 عربي عام", en: "🌐 General Arabic-speaking audience" } },
    ],
  },
};

/** The service option ids of the TYPE question as the pricing agent's service types. */
const SERVICE_TYPE_BY_OPTION: Record<string, PricingServiceType> = {
  design: "design",
  ads: "ads",
  social_media: "social",
  content: "content",
  seo: "seo",
  other: "other",
};

const SERVICE_REQUEST_STORAGE_KEY = "ofoq:chat:service-request";
const SERVICE_REQUEST_WELCOME_ID = "service-request-welcome";
/** The closing assistant message of a completed request: the price estimation. */
const SERVICE_REQUEST_ESTIMATE_ID = "service-request-estimate";
/** First assistant message of a service request. Displayed in the chat only; it is not saved to the conversation. */
const SERVICE_REQUEST_WELCOME: Record<Locale, string> = {
  ar: "أهلاً بك في أفق 👋\nأنا مساعد أفق، راح أساعدك تجهّز طلبك خطوة بخطوة.\n\nأول شي: شنو نوع الخدمة اللي تحتاجها؟ (تصميم / إعلانات / سوشيال ميديا / محتوى / SEO / غير ذلك)",
  en: "Welcome to Ofoq 👋\nI'm the Ofoq assistant, and I'll help you build your request step by step.\n\nFirst: what type of service do you need? (Design / Ads / Social media / Content / SEO / Other)",
};

/** Shown after the last answer; the estimate follows it immediately. */
function serviceRequestSummary(answers: ServiceRequestAnswers, locale: Locale): string {
  const label = (step: ServiceRequestQuestionStep) => optionLabel(step, answers[SERVICE_REQUEST_QUESTIONS[step].answerKey], locale);
  return locale === "ar"
    ? `تمام، فهمت طلبك 👌\n\n- الخدمة: ${label("TYPE")}\n- الحجم: ${label("SIZE")}\n- المنصات: ${label("PLATFORMS")}\n- التسليم: ${label("DEADLINE")}\n- الميزانية: ${label("BUDGET")}\n- نوع المشروع: ${label("BUSINESS_TYPE")}\n- سعر المنتج: ${label("PRICE_RANGE")}\n- المنطقة المستهدفة: ${label("TARGETING")}\n\nخليني أحسب لك تقديراً واضحاً...`
    : `Great, I've got your request 👌\n\n- Service: ${label("TYPE")}\n- Size: ${label("SIZE")}\n- Platforms: ${label("PLATFORMS")}\n- Delivery: ${label("DEADLINE")}\n- Budget: ${label("BUDGET")}\n- Business type: ${label("BUSINESS_TYPE")}\n- Product price: ${label("PRICE_RANGE")}\n- Target area: ${label("TARGETING")}\n\nLet me prepare a clear estimate...`;
}

function optionLabel(step: ServiceRequestQuestionStep, optionId: string | undefined, locale: Locale): string {
  return SERVICE_REQUEST_QUESTIONS[step].options.find((option) => option.id === optionId)?.label[locale] ?? optionId ?? "";
}

function nextServiceRequestStep(step: ServiceRequestStep): ServiceRequestStep {
  return SERVICE_REQUEST_STEPS[Math.min(SERVICE_REQUEST_STEPS.indexOf(step) + 1, SERVICE_REQUEST_STEPS.length - 1)];
}

function isQuestionStep(step: ServiceRequestStep): step is ServiceRequestQuestionStep {
  return step !== "SUMMARY";
}

/** True once every question has an answer: only then can the estimate be shown. */
export function isServiceRequestComplete(answers: ServiceRequestAnswers): boolean {
  return SERVICE_REQUEST_STEPS.filter(isQuestionStep).every(
    (step) => Boolean(answers[SERVICE_REQUEST_QUESTIONS[step].answerKey]),
  );
}

/**
 * Convert the guided answers into the pricing agent's input. Every value is
 * checked against the choices actually offered, so edited session storage can
 * never select an unpublished service or targeting multiplier.
 */
export function requestPricingInput(answers: ServiceRequestAnswers): PricingInput {
  const budget: BudgetBand = isBudgetBand(answers.budget) ? answers.budget : "under_200";
  const targeting = SERVICE_REQUEST_QUESTIONS.TARGETING.options.some((option) => option.id === answers.targeting)
    ? answers.targeting as TargetingArea
    : "iraq_all";
  return {
    type: SERVICE_TYPE_BY_OPTION[answers.type ?? "other"] ?? "other",
    size: answers.size === "small" || answers.size === "large" ? answers.size : "medium",
    platforms: answers.platforms === "multiple" ? "multiple" : "single",
    deadline:
      answers.deadline === "urgent_3_days" ? "urgent" : answers.deadline === "flexible_14_days" ? "flexible" : "normal",
    budget,
    targeting,
  };
}

function isBudgetBand(value: string | undefined): value is BudgetBand {
  return value === "under_200" || value === "200_500" || value === "500_1500" || value === "over_1500";
}

function contactOptions(locale: Locale): string[] {
  return locale === "ar"
    ? [
        "كيف تحب يتواصل معك فريق أفق؟",
        "□ 📱 واتساب",
        "□ 📧 إيميل: البريد المسجّل بحسابك",
        "□ 💬 إشعار في الموقع",
      ]
    : [
        "How would you like the Ofoq team to contact you?",
        "□ 📱 WhatsApp",
        "□ 📧 Email: the address registered to your account",
        "□ 💬 In-app notification",
      ];
}

/** The final, client-facing message after the nine-step guided request. */
export function serviceRequestEstimate(answers: ServiceRequestAnswers, locale: Locale): string {
  const result = calculateServiceEstimate(requestPricingInput(answers));
  const ar = locale === "ar";
  const contact = contactOptions(locale);

  if (result.service === "ads" && result.resultsKind === "numbers") {
    const reach = result.expectedReach ?? [0, 0];
    const visits = result.expectedVisits ?? [0, 0];
    const leads = result.expectedLeads ?? [0, 0];
    const formatRange = ([min, max]: [number, number]) => `~${formatCount(min, locale)}-${formatCount(max, locale)}`;
    const lines = [
      `${ar ? "ميزانيتك" : "Your budget"}: ${formatUsd(result.budgetAmount, locale)} ${ar ? "شهرياً" : "per month"} ${result.budgetEmoji}`,
    ];

    if (result.budgetQuality === "weak" || result.budgetQuality === "medium") {
      lines.push(
        "",
        ar ? "💡 صريحين معك:" : "💡 To be transparent:",
        `${formatUsd(result.budgetAmount, locale)} ${ar ? `تكفي لـ ${result.estimatedAdDays} يوم إعلان فعّال.` : `covers about ${result.estimatedAdDays} active ad days.`}`,
        "",
        ar ? "📊 النتائج المتوقعة:" : "📊 Expected results:",
      );
    } else {
      lines.push("", ar ? "📊 النتائج المتوقعة شهرياً:" : "📊 Expected monthly results:");
    }

    lines.push(
      ar ? `• الظهور: ${formatRange(reach)}` : `• Impressions: ${formatRange(reach)}`,
      ar ? `• الزيارات: ${formatRange(visits)}` : `• Visits: ${formatRange(visits)}`,
      ar ? `• المهتمون: ${formatRange(leads)}` : `• Interested people: ${formatRange(leads)}`,
      "",
      ar ? "الأرقام تقديرية وليست ضماناً للنتائج." : "These are conservative estimates, not guaranteed results.",
      "",
      ...contact,
    );
    return lines.join("\n");
  }

  if (result.minPrice === null || result.maxPrice === null) {
    return [
      ar
        ? "ما عندنا نطاق سعر معتمد لهذا النوع، وما راح نخمن رقماً. يحتاج الطلب مراجعة تفاصيله قبل تحديد السعر."
        : "We do not have an approved price range for this request, so we will not guess. The scope needs review before a price can be set.",
      "",
      ...contact,
    ].join("\n");
  }

  return [
    `${ar ? "السعر التقديري" : "Estimated price"}: ${formatUsd(result.minPrice, locale)}-${formatUsd(result.maxPrice, locale)}`,
    "",
    ...contact,
  ].join("\n");
}

/**
 * The option of `step` a typed message stands for, if any: it must be the whole
 * message and equal an option's Arabic label, English label or id ("تصميم",
 * "Design", "design"). Case, extra spaces, trailing punctuation, "_"/"-" and
 * Arabic letter variants (أ/إ/آ, ة/ه, ى/ي, tatweel) are ignored.
 */
export function matchServiceOption(step: ServiceRequestQuestionStep, text: string): string | null {
  const typed = normalizeAnswer(text);
  if (!typed) return null;
  const match = SERVICE_REQUEST_QUESTIONS[step].options.find((option) =>
    [option.id, option.label.ar, option.label.en].some((candidate) => normalizeAnswer(candidate) === typed));
  return match?.id ?? null;
}

function normalizeAnswer(value: string): string {
  return value
    .toLowerCase()
    .replace(/\u0640/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/[_\-–]/g, " ")
    .replace(/[.!?؟،,؛;]+$/u, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Service-request chat using the fixed public pricing table. */
export function AssistantChat({ locale, intent }: { locale: Locale; intent?: string }) {
  const ar = locale === "ar";
  const copy = dictionaries[locale].assistant;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversationId, setConversationId] = useState("");
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [providerAvailable, setProviderAvailable] = useState(false);
  /** True once the platform really handed this conversation to a human. */
  const [escalated, setEscalated] = useState(false);
  /** Set only when the chat was opened with ?intent=service_request. */
  const [serviceRequest, setServiceRequest] = useState<ServiceRequestContext | null>(null);
  const tailRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/chat", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Unable to open chat.");
        const loadedConversationId: string = payload.data?.conversationId || "";
        const loadedMessages: ChatMessage[] = Array.isArray(payload.data?.messages) ? payload.data.messages : [];
        setConversationId(loadedConversationId);
        setMessages(loadedMessages);
        setServiceRequest(intent === "service_request" ? openServiceRequest(loadedConversationId, loadedMessages) : null);
        setProviderAvailable(Boolean(payload.provider?.configured));
        setReady(true);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Unable to open chat.");
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [intent]);

  useEffect(() => { tailRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [messages, sending]);

  async function sendMessage(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const message = input.trim();
    if (!message || sending || loading || !ready) return;
    // A typed answer that names an option of the open question counts as choosing it (same as the button).
    const typedOption = serviceRequest && isQuestionStep(serviceRequest.step) ? matchServiceOption(serviceRequest.step, message) : null;
    if (typedOption) {
      setError("");
      setInput("");
      chooseServiceOption(typedOption);
      return;
    }
    setError("");
    setInput("");
    setSending(true);
    const tempId = `pending-${Date.now()}`;
    const optimistic: ChatMessage = { id: tempId, sender: "CLIENT", body: message, language: locale, createdAt: new Date().toISOString() };
    setMessages((current) => [...current, optimistic]);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || (ar ? "تعذر إرسال الرسالة." : "Message could not be sent."));
      const result = payload.data;
      setConversationId(result.conversationId || conversationId);
      setMessages((current) => [
        ...current.filter((item) => item.id !== tempId),
        result.userMessage as ChatMessage,
        { ...(result.reply as ChatMessage), provider: result.provider ?? result.reply?.provider ?? null },
      ]);
      setProviderAvailable(Boolean(result.providerAvailable));
      // The route only reports `escalated` after the alert row was written.
      if (result.escalated) setEscalated(true);
    } catch (reason) {
      setMessages((current) => current.filter((item) => item.id !== tempId));
      setInput(message);
      setError(reason instanceof Error ? reason.message : (ar ? "تعذر إرسال الرسالة." : "Message could not be sent."));
    } finally {
      setSending(false);
    }
  }

  /**
   * A guided answer, from a button or a typed message that matches an option:
   * saved in the request context (and sessionStorage), then the next question —
   * or the summary after BUDGET — is shown. Nothing is sent to the API.
   */
  function chooseServiceOption(optionId: string) {
    if (!serviceRequest || sending || !isQuestionStep(serviceRequest.step)) return;
    const step = serviceRequest.step;
    const question = SERVICE_REQUEST_QUESTIONS[step];
    if (!question.options.some((option) => option.id === optionId)) return;
    const next: ServiceRequestContext = {
      ...serviceRequest,
      step: nextServiceRequestStep(step),
      answers: { ...serviceRequest.answers, [question.answerKey]: optionId },
      answerLog: [...serviceRequest.answerLog, { step, afterMessageId: messages.length > 0 ? messages[messages.length - 1].id : null, answeredAt: new Date().toISOString() }],
    };
    setServiceRequest(next);
    saveServiceRequest(next);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  }

  // The service-request exchange is displayed, not saved: the welcome sits after the message that was last when the
  // request started, and each answer (with the question that follows it) after the message that was last when it was chosen.
  const visibleMessages = serviceRequest ? withServiceRequest(messages, serviceRequest, locale) : messages;
  const pendingQuestion = serviceRequest && isQuestionStep(serviceRequest.step) ? SERVICE_REQUEST_QUESTIONS[serviceRequest.step] : null;

  const quickReplies = ar
    ? ["أريد إدارة حسابات التواصل", "أحتاج إلى موقع إلكتروني", "أريد معرفة الأسعار"]
    : ["I need social media management", "I need a website", "I would like to understand pricing"];

  return (
    <div className="chat-layout">
      <section className="chat-panel platform-card" aria-label={ar ? "محادثة مساعد أفق" : "Ofoq assistant conversation"}>
        <div className="chat-panel-header">
          <div className="assistant-avatar"><span>أ</span><i /></div>
          <div className="assistant-identity"><strong>{copy.title}</strong><span>{copy.badge}</span></div>
          <span className="chat-encrypted"><span>◇</span>{ar ? "محادثة خاصة" : "Private chat"}</span>
        </div>

        {intent === "service_request" && <div className="chat-context-note">{ar ? "راح نسألك كم سؤال سريع حتى نفهم مشروعك ونحسب تقديراً واضحاً." : "Answer a few quick questions so we can understand your business and give a clear estimate."}</div>}
        {ready && <div className="chat-provider-note"><span>i</span>{providerAvailable ? (ar ? "المساعد متصل بمزودي الذكاء الاصطناعي (Groq، Gemini، Cohere وغيرها). قد تُرسل رسائل المحادثة إلى المزود لتوليد الرد، ونعود إلى الردود المحلية إذا تعذّرت الخدمة. لا تشارك كلمات مرور أو بيانات دفع." : "The assistant is connected to AI providers (Groq, Gemini, Cohere and others). Conversation messages may be sent to a provider for generation, with local replies as a fallback. Do not share passwords or payment details.") : copy.providerOff}</div>}
        {escalated && <div className="chat-escalation-note" role="status"><span>✔</span>{ar ? "تم تحويل محادثتك إلى فريق أفق البشري: أُنشئ تنبيه في لوحة الوكالة وتم إشعار المالك. سيتواصل معك أحد أعضاء الفريق." : "Your conversation has been handed over to the Ofoq human team: an alert was created in the agency control room and the owner was notified. A team member will contact you."}</div>}
        {error && <div className="form-notice form-notice-error chat-error" role="alert">{error}</div>}

        <div className="chat-messages" role="log" aria-live="polite" aria-relevant="additions text">
          {loading ? <div className="chat-loading"><span className="loading-orbit" />{ar ? "جارٍ فتح المحادثة…" : "Opening your conversation…"}</div> : visibleMessages.length === 0 ? <div className="chat-loading">{ar ? "لا توجد رسائل بعد. ابدأ بكتابة ما تحتاجه." : "No messages yet. Tell us what you need."}</div> : visibleMessages.map((message) => {
            const own = message.sender === "CLIENT";
            const estimate = message.id === SERVICE_REQUEST_ESTIMATE_ID;
            return <article className={`chat-message ${own ? "chat-message-client" : "chat-message-assistant"}${estimate ? " chat-message-estimate" : ""}`} key={message.id}>
              {!own && <span className="message-sender">{message.sender === "STAFF" ? (ar ? "فريق أفق" : "Ofoq team") : copy.title}</span>}
              <p dir={message.language === "en" ? "ltr" : message.language === "ar" ? "rtl" : undefined}>{message.body}</p>

              <time>{formatTime(message.createdAt, locale)}</time>
            </article>;
          })}
          {sending && <div className="chat-message chat-message-assistant chat-typing"><span className="typing-dots"><i /><i /><i /></span><span>{copy.typing}</span></div>}
          <div ref={tailRef} />
        </div>

        {pendingQuestion && !loading && <div className="chat-quick-replies chat-service-options" role="group" aria-label={pendingQuestion.question[locale]}>{pendingQuestion.options.map((option) => <button type="button" key={option.id} onClick={() => chooseServiceOption(option.id)} disabled={sending}>{option.label[locale]}</button>)}</div>}

        {!serviceRequest && messages.length <= 1 && !loading && <div className="chat-quick-replies" aria-label={ar ? "اقتراحات للبدء" : "Suggested prompts"}>{quickReplies.map((reply) => <button type="button" key={reply} onClick={() => setInput(reply)}>{reply}</button>)}</div>}

        <form className="chat-composer" onSubmit={sendMessage}>
          <label className="sr-only" htmlFor="assistant-message">{copy.placeholder}</label>
          <textarea id="assistant-message" dir={locale === "en" ? "ltr" : "rtl"} rows={1} maxLength={2000} placeholder={copy.placeholder} value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={handleKeyDown} disabled={loading || sending || !ready} />
          <button className="chat-send-button" type="submit" aria-label={ar ? "إرسال الرسالة" : "Send message"} disabled={!input.trim() || sending || loading || !ready}><span aria-hidden="true">➤</span></button>
          <small>{ar ? "Enter للإرسال · Shift + Enter لسطر جديد" : "Enter to send · Shift + Enter for a new line"}</small>
        </form>
      </section>

      <aside className="chat-aside">
        <article className="platform-card chat-aside-card">
          <span className="eyebrow">{ar ? "معًا خطوة بخطوة" : "ONE STEP AT A TIME"}</span>
          <h2>{ar ? "كيف يساعدك أفق؟" : "How Ofoq helps"}</h2>
          <ol className="chat-steps">
            {(ar ? ["نفهم هدفك واحتياجك تدريجيًا.", "نلخص ما فهمناه ونتأكد منه.", "نقترح خدمة ومدة وسعرًا واضحًا.", "تتابع مشروعك من بوابة العميل."] : ["We learn your goals gradually.", "We summarise and confirm the brief.", "We suggest a service, timeline and clear price.", "Follow delivery in your client portal."]).map((step, index) => <li key={step}><span>{String(index + 1).padStart(2, "0")}</span>{step}</li>)}
          </ol>
          <p className="chat-human-note">{ar ? "إذا كان الطلب غير واضح أو استثنائيًا، لن نخترع سعرًا أو وعدًا. اكتب «أريد التحدث مع شخص من الفريق» متى شئت: يُنشأ تنبيه فعلي في لوحة الوكالة ويصل بريد إلى المالك." : "For unusual or unclear requests, we will not invent a price or promise. Write “I want to speak with a person” at any time: a real alert is created in the agency control room and the owner is notified by email."}</p>
        </article>
        <article className="platform-card chat-aside-card chat-privacy-card"><span className="privacy-icon">◇</span><div><strong>{ar ? "خصوصيتك أولًا" : "Privacy first"}</strong><p>{ar ? "لا ترسل بيانات بطاقة أو كلمة مرور أو معلومات حساسة في المحادثة." : "Do not share card details, passwords, or sensitive information in chat."}</p></div></article>
      </aside>
    </div>
  );
}

/**
 * Continues this tab's service request when it belongs to the same conversation
 * (e.g. after a refresh); otherwise starts a new one right after the last saved
 * message and keeps it in sessionStorage.
 */
function openServiceRequest(conversationId: string, messages: ChatMessage[]): ServiceRequestContext {
  const stored = readServiceRequest();
  if (stored && stored.conversationId === conversationId) return stored;
  const context: ServiceRequestContext = {
    intent: "service_request",
    conversationId,
    afterMessageId: messages.length > 0 ? messages[messages.length - 1].id : null,
    startedAt: new Date().toISOString(),
    step: "TYPE",
    answers: {},
    answerLog: [],
  };
  saveServiceRequest(context);
  return context;
}

function saveServiceRequest(context: ServiceRequestContext): void {
  try {
    window.sessionStorage.setItem(SERVICE_REQUEST_STORAGE_KEY, JSON.stringify(context));
  } catch {
    // Storage can be blocked (private mode, browser policy); the request still works for this page view.
  }
}

/**
 * Reads this tab's request. A context saved before the guided questions existed
 * (no step) — or one whose progress does not add up — continues from TYPE.
 */
function readServiceRequest(): ServiceRequestContext | null {
  try {
    const stored = JSON.parse(window.sessionStorage.getItem(SERVICE_REQUEST_STORAGE_KEY) ?? "null");
    if (stored?.intent !== "service_request" || typeof stored.conversationId !== "string") return null;
    const answerLog: ServiceRequestAnswerEvent[] = Array.isArray(stored.answerLog) ? stored.answerLog : [];
    // No band is translated for a stored request: the bands are exactly the ones
    // the question offers, so an answer that is no longer an option makes the
    // progress inconsistent and the request restarts from TYPE.
    const answers: ServiceRequestAnswers = stored.answers && typeof stored.answers === "object" ? stored.answers : {};
    const step: ServiceRequestStep = SERVICE_REQUEST_STEPS[answerLog.length];
    const consistent = answerLog.length < SERVICE_REQUEST_STEPS.length && stored.step === step && answerLog.every((event, index) => {
      const expected = SERVICE_REQUEST_STEPS[index] as ServiceRequestQuestionStep;
      const answer = answers[SERVICE_REQUEST_QUESTIONS[expected].answerKey];
      return event?.step === expected && SERVICE_REQUEST_QUESTIONS[expected].options.some((option) => option.id === answer);
    });
    if (consistent) return { ...stored, step, answers, answerLog };
    const reset = { ...stored, step: "TYPE" as const, answers: {}, answerLog: [] };
    saveServiceRequest(reset);
    return reset;
  } catch {
    return null;
  }
}

/**
 * Merges the displayed service-request exchange into the saved history: the
 * welcome after its anchor message, then for each answer the client's choice
 * followed by the next question (or the summary) after the message that was
 * last when it was chosen, and finally — once every question is answered — the
 * price estimation the pricing agent computed. Entries whose anchor is no
 * longer loaded go first.
 */
function withServiceRequest(
  messages: ChatMessage[],
  context: ServiceRequestContext,
  locale: Locale,
): ChatMessage[] {
  const entries: Array<{ afterMessageId: string | null; message: ChatMessage }> = [
    { afterMessageId: context.afterMessageId, message: { id: SERVICE_REQUEST_WELCOME_ID, sender: "ASSISTANT", body: SERVICE_REQUEST_WELCOME[locale], language: locale, createdAt: context.startedAt } },
  ];
  for (const event of context.answerLog) {
    const next = nextServiceRequestStep(event.step);
    const answer = context.answers[SERVICE_REQUEST_QUESTIONS[event.step].answerKey];
    entries.push(
      { afterMessageId: event.afterMessageId, message: { id: `service-request-answer-${event.step}`, sender: "CLIENT", body: optionLabel(event.step, answer, locale), language: locale, createdAt: event.answeredAt } },
      { afterMessageId: event.afterMessageId, message: { id: `service-request-${next.toLowerCase()}`, sender: "ASSISTANT", body: isQuestionStep(next) ? SERVICE_REQUEST_QUESTIONS[next].question[locale] : serviceRequestSummary(context.answers, locale), language: locale, createdAt: event.answeredAt } },
    );
  }
  if (isServiceRequestComplete(context.answers)) {
    // Anchored to the TARGETING answer, i.e. displayed right after the summary.
    const last = context.answerLog[context.answerLog.length - 1];
    entries.push({
      afterMessageId: last ? last.afterMessageId : context.afterMessageId,
      message: {
        id: SERVICE_REQUEST_ESTIMATE_ID,
        sender: "ASSISTANT",
        body: serviceRequestEstimate(context.answers, locale),
        language: locale,
        createdAt: last ? last.answeredAt : context.startedAt,
      },
    });
  }
  const loaded = new Set(messages.map((message) => message.id));
  const placed = (anchor: string | null) => entries.filter((entry) => entry.afterMessageId === anchor).map((entry) => entry.message);
  const orphans = entries.filter((entry) => entry.afterMessageId === null || !loaded.has(entry.afterMessageId)).map((entry) => entry.message);
  return [...orphans, ...messages.flatMap((message) => [message, ...placed(message.id)])];
}

function formatTime(value: string, locale: Locale): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-IQ-u-nu-latn" : "en-GB", { hour: "2-digit", minute: "2-digit" }).format(date);
}
