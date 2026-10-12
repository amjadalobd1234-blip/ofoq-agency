"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

import {
  SERVICE_REQUEST_BASIC_STEPS,
  SERVICE_REQUEST_ORDER_CODE,
  SERVICE_REQUEST_QUESTIONS,
  SERVICE_REQUEST_STEPS,
  SERVICE_REQUEST_WELCOME,
  answerServiceRequest,
  currentQuestionStep,
  isQuestionStep,
  matchServiceOption,
  optionLabel,
  replayServiceRequest,
  requestPricingInput,
  serviceRequestClarification,
  serviceRequestConfirmation,
  serviceRequestEstimate,
  serviceRequestSummary,
  submitWhatsappNumber,
  whatsappNumberPrompt,
  type ServiceRequestAnswerKey,
  type ServiceRequestAnswers,
  type ServiceRequestOption,
  type ServiceRequestQuestionStep,
  type ServiceRequestState,
  type ServiceRequestStep,
} from "@/lib/agents/service-request";
import type { Locale } from "@/lib/domain/types";
import { dictionaries } from "@/lib/i18n/dictionaries";

// The guided request lives in `@/lib/agents/service-request` so it can be tested
// without the DOM; these re-exports keep the chat's public surface unchanged.
export {
  SERVICE_REQUEST_BASIC_STEPS,
  SERVICE_REQUEST_ORDER_CODE,
  SERVICE_REQUEST_QUESTIONS,
  SERVICE_REQUEST_STEPS,
  SERVICE_REQUEST_WELCOME,
  currentQuestionStep,
  isQuestionStep,
  matchServiceOption,
  optionLabel,
  serviceRequestClarification,
  serviceRequestConfirmation,
  serviceRequestEstimate,
  serviceRequestSummary,
  whatsappNumberPrompt,
};
export type { ServiceRequestAnswers, ServiceRequestQuestionStep, ServiceRequestStep };

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
  step: ServiceRequestStep;
  /** Chosen option ids (language independent), e.g. { type: "design", size: "small" }. */
  answers: ServiceRequestAnswers;
  /** When each answer was given and which saved message was last at that moment. */
  answerLog: ServiceRequestAnswerEvent[];
  /** True after a rejected WhatsApp number, so the rejection can be shown again. */
  phoneError: boolean;
  /** Registered client email, used in the pricing message and the confirmation. */
  email: string | null;
  completedAt: string | null;
}

interface ServiceRequestAnswerEvent {
  step: ServiceRequestStep;
  optionId?: string;
  afterMessageId: string | null;
  answeredAt: string;
}

const SERVICE_REQUEST_STORAGE_KEY = "ofoq:chat:service-request";
const SERVICE_REQUEST_WELCOME_ID = "service-request-welcome";
/** The closing assistant message of a completed request: the price estimation. */
const SERVICE_REQUEST_ESTIMATE_ID = "service-request-estimate";
const SERVICE_REQUEST_CLARIFICATION_ID = "service-request-clarification";
const SERVICE_REQUEST_PHONE_ERROR_ID = "service-request-phone-error";

function serviceRequestState(context: ServiceRequestContext): ServiceRequestState {
  return {
    step: context.step,
    answers: context.answers,
    answerLog: context.answerLog.map((event) => ({ step: event.step, answeredAt: event.answeredAt })),
    completedAt: context.completedAt,
  };
}

/** True once every question the request needs has an answer. */
export function isServiceRequestComplete(answers: ServiceRequestAnswers): boolean {
  return SERVICE_REQUEST_BASIC_STEPS.every((step) => Boolean(answers[SERVICE_REQUEST_QUESTIONS[step].answerKey]));
}

/**
 * The pricing input of a stored request. Every value is checked against the
 * choices actually offered, so edited session storage can never select an
 * unpublished service or targeting multiplier.
 */
export { requestPricingInput };

/** The contact prompt of an option; the email is shown when it is known. */
export function contactOptionLabel(option: ServiceRequestOption, locale: Locale, email?: string | null): string {
  const label = locale === "ar" ? option.labelAr : option.labelEn;
  if (option.id !== "email") return label;
  const address = email?.trim();
  if (!address) return label;
  return `${label}: ${address}`;
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
  /** Shown when neither the matcher nor the AI could name an option. */
  const [clarification, setClarification] = useState("");
  const tailRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/chat", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Unable to open chat.");
        const loadedConversationId: string = payload.data?.conversationId || "";
        const loadedMessages: ChatMessage[] = Array.isArray(payload.data?.messages) ? payload.data.messages : [];
        const email: string | null = typeof payload.data?.email === "string" ? payload.data.email : null;
        setConversationId(loadedConversationId);
        setMessages(loadedMessages);
        setServiceRequest(intent === "service_request" ? openServiceRequest(loadedConversationId, loadedMessages, email) : null);
        setProviderAvailable(Boolean(payload.provider?.configured));
        setReady(true);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Unable to open chat.");
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [intent]);

  useEffect(() => { tailRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [messages, sending, clarification]);

  /**
   * Asks the AI (Groq first, through the provider chain) which service type the
   * client means. Only a published option id is accepted; anything else is null.
   */
  async function askAiForServiceType(message: string): Promise<string | null> {
    try {
      const response = await fetch("/api/chat/service-intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      if (!response.ok) return null;
      const payload = await response.json();
      const optionId: unknown = payload?.data?.optionId;
      return SERVICE_REQUEST_QUESTIONS.TYPE.options.some((option) => option.id === optionId) ? (optionId as string) : null;
    } catch {
      return null;
    }
  }

  /** Reports the finished request so the team alert and the owner email are created. */
  async function reportCompletedRequest(context: ServiceRequestContext): Promise<void> {
    try {
      await fetch("/api/chat/service-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers: context.answers, locale, conversationId: context.conversationId }),
      });
    } catch {
      // The client already has the confirmation and the order reference: a
      // reporting failure must never block the conversation.
    }
  }

  async function sendMessage(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const message = input.trim();
    if (!message || sending || loading || !ready) return;

    // A guided request answers through the same composer: typed text is matched
    // against the options of the open question (exact → partial → AI intent).
    if (serviceRequest) {
      if (serviceRequest.step === "PHONE") {
        setError("");
        setInput("");
        applyPhoneNumber(message);
        return;
      }
      const openStep = currentQuestionStep(serviceRequestState(serviceRequest));
      if (openStep) {
        const step = openStep;
        const typed = matchServiceOption(step, message);
        if (typed) {
          setError("");
          setInput("");
          setClarification("");
          chooseServiceOption(typed);
          return;
        }
        if (step === "TYPE") {
          setSending(true);
          const aiOption = await askAiForServiceType(message);
          setSending(false);
          if (aiOption) {
            setError("");
            setInput("");
            setClarification("");
            chooseServiceOption(aiOption);
            return;
          }
        }
        // Nothing matched (and the AI could not extract an intent): show the
        // available options again, save no value, and keep the conversation open.
        setError("");
        setInput("");
        setClarification(serviceRequestClarification(step, locale));
        void sendToAssistant(message);
        return;
      }
    }

    setError("");
    setInput("");
    await sendToAssistant(message);
  }

  /** Normal (unmatched) chat turn: saved to the conversation and answered by the assistant. */
  async function sendToAssistant(message: string) {
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
   * or the summary/confirmation — is shown. Nothing is sent to the API.
   */
  function chooseServiceOption(optionId: string) {
    if (!serviceRequest || sending) return;
    const step = currentQuestionStep(serviceRequestState(serviceRequest));
    if (!step) return;
    const question = SERVICE_REQUEST_QUESTIONS[step];
    if (!question.options.some((option) => option.id === optionId)) return;
    const next = answerServiceRequest(serviceRequestState(serviceRequest), optionId);
    const context: ServiceRequestContext = {
      ...serviceRequest,
      step: next.step,
      answers: next.answers,
      completedAt: next.completedAt ?? null,
      phoneError: false,
      answerLog: [
        ...serviceRequest.answerLog,
        {
          step,
          optionId,
          afterMessageId: messages.length > 0 ? messages[messages.length - 1].id : null,
          answeredAt: new Date().toISOString(),
        },
      ],
    };
    setClarification("");
    setServiceRequest(context);
    saveServiceRequest(context);
    if (context.step === "DONE") void reportCompletedRequest(context);
  }

  /** Saves the WhatsApp number, or asks for it again when it is not valid. */
  function applyPhoneNumber(raw: string) {
    if (!serviceRequest) return;
    const attempt = submitWhatsappNumber(serviceRequestState(serviceRequest), raw);
    if (attempt.error) {
      setError("");
      const rejected = { ...serviceRequest, phoneError: true };
      setServiceRequest(rejected);
      saveServiceRequest(rejected);
      return;
    }
    const context: ServiceRequestContext = {
      ...serviceRequest,
      step: attempt.state.step,
      answers: attempt.state.answers,
      phoneError: false,
      completedAt: attempt.state.completedAt ?? null,
      answerLog: [
        ...serviceRequest.answerLog,
        {
          step: "PHONE",
          afterMessageId: messages.length > 0 ? messages[messages.length - 1].id : null,
          answeredAt: new Date().toISOString(),
        },
      ],
    };
    setClarification("");
    setServiceRequest(context);
    saveServiceRequest(context);
    void reportCompletedRequest(context);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  }

  // The service-request exchange is displayed, not saved: each answer and the
  // message that follows it sit after the message that was last when it was
  // given, and the pricing message follows the summary.
  const visibleMessages = serviceRequest ? withServiceRequest(messages, serviceRequest, locale, clarification) : messages;
  const openQuestionStep = serviceRequest ? currentQuestionStep(serviceRequestState(serviceRequest)) : null;
  const pendingQuestion = openQuestionStep ? SERVICE_REQUEST_QUESTIONS[openQuestionStep] : null;
  const pendingPhone = serviceRequest?.step === "PHONE";

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

        {intent === "service_request" && <div className="chat-context-note">{ar ? "راح نسألك أربع أسئلة سريعة حتى نفهم مشروعك ونحسب تقديراً واضحاً." : "Four quick questions so we can understand your business and give a clear estimate."}</div>}
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

        {pendingQuestion && !loading && <div className="chat-quick-replies chat-service-options" role="group" aria-label={pendingQuestion.question[locale]}>{pendingQuestion.options.map((option) => <button type="button" key={option.id} onClick={() => chooseServiceOption(option.id)} disabled={sending}>{contactOptionLabel(option, locale, serviceRequest?.email)}</button>)}</div>}

        {pendingPhone && !loading && <div className="chat-quick-replies chat-service-options chat-phone-prompt" role="group" aria-label={ar ? "رقم واتساب" : "WhatsApp number"}><span>{whatsappNumberPrompt(locale)}</span></div>}

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
function openServiceRequest(conversationId: string, messages: ChatMessage[], email: string | null): ServiceRequestContext {
  const stored = readServiceRequest();
  if (stored && stored.conversationId === conversationId) return { ...stored, email: stored.email ?? email };
  const context: ServiceRequestContext = {
    intent: "service_request",
    conversationId,
    afterMessageId: messages.length > 0 ? messages[messages.length - 1].id : null,
    startedAt: new Date().toISOString(),
    step: "TYPE",
    answers: {},
    answerLog: [],
    phoneError: false,
    email,
    completedAt: null,
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
    const answers: ServiceRequestAnswers = stored.answers && typeof stored.answers === "object" ? stored.answers : {};
    const step: ServiceRequestStep = SERVICE_REQUEST_STEPS.includes(stored.step) ? stored.step : "TYPE";
    // The progress is only trusted when replaying its own answers lands exactly
    // on the stored step: anything else restarts from TYPE.
    const replayed = answerLog.length <= SERVICE_REQUEST_STEPS.length ? replayServiceRequest(answerLog, answers) : null;
    if (replayed && replayed.step === step) {
      return {
        intent: "service_request",
        conversationId: stored.conversationId,
        afterMessageId: typeof stored.afterMessageId === "string" ? stored.afterMessageId : null,
        startedAt: typeof stored.startedAt === "string" ? stored.startedAt : new Date().toISOString(),
        step,
        answers,
        answerLog,
        phoneError: Boolean(stored.phoneError),
        email: typeof stored.email === "string" ? stored.email : null,
        completedAt: typeof stored.completedAt === "string" ? stored.completedAt : null,
      };
    }
    const reset: ServiceRequestContext = {
      intent: "service_request",
      conversationId: stored.conversationId,
      afterMessageId: typeof stored.afterMessageId === "string" ? stored.afterMessageId : null,
      startedAt: typeof stored.startedAt === "string" ? stored.startedAt : new Date().toISOString(),
      step: "TYPE",
      answers: {},
      answerLog: [],
      phoneError: false,
      email: typeof stored.email === "string" ? stored.email : null,
      completedAt: null,
    };
    saveServiceRequest(reset);
    return reset;
  } catch {
    return null;
  }
}

/**
 * The message that follows an answered step: the next question, the summary, the
 * WhatsApp prompt or the channel confirmation.
 */
function followUpMessage(context: ServiceRequestContext, event: ServiceRequestAnswerEvent, locale: Locale): string {
  switch (event.step) {
    case "TYPE":
      return SERVICE_REQUEST_QUESTIONS.SIZE.question[locale];
    case "SIZE":
      return SERVICE_REQUEST_QUESTIONS.BUDGET.question[locale];
    case "BUDGET":
      return SERVICE_REQUEST_QUESTIONS.TARGETING.question[locale];
    case "TARGETING":
      return serviceRequestSummary(context.answers, locale);
    case "CONTACT":
      return event.optionId === "whatsapp"
        ? whatsappNumberPrompt(locale)
        : serviceRequestConfirmation(context.answers, locale, { email: context.email });
    default:
      // PHONE: the request is complete once the number is saved.
      return serviceRequestConfirmation(context.answers, locale, { email: context.email });
  }
}

/** The client's own bubble for an answered step. */
function answerMessage(context: ServiceRequestContext, event: ServiceRequestAnswerEvent, locale: Locale): string {
  if (event.step === "PHONE") return context.answers.phone ?? "";
  if (!event.optionId) return "";
  return optionLabel(event.step as ServiceRequestQuestionStep, event.optionId, locale);
}

/**
 * Merges the displayed service-request exchange into the saved history: the
 * welcome after its anchor message, then for each answer the client's choice
 * followed by the next question (or summary/confirmation) after the message that
 * was last when it was chosen, the pricing message right after the summary, and
 * the clarification message when the last free-text answer matched no option.
 * Entries whose anchor is no longer loaded go first.
 */
function withServiceRequest(
  messages: ChatMessage[],
  context: ServiceRequestContext,
  locale: Locale,
  clarification: string,
): ChatMessage[] {
  const entries: Array<{ afterMessageId: string | null; message: ChatMessage }> = [
    { afterMessageId: context.afterMessageId, message: { id: SERVICE_REQUEST_WELCOME_ID, sender: "ASSISTANT", body: SERVICE_REQUEST_WELCOME[locale], language: locale, createdAt: context.startedAt } },
  ];
  for (const [index, event] of context.answerLog.entries()) {
    const answer = answerMessage(context, event, locale);
    if (answer) {
      entries.push({
        afterMessageId: event.afterMessageId,
        message: { id: `service-request-answer-${index}-${event.step}`, sender: "CLIENT", body: answer, language: locale, createdAt: event.answeredAt },
      });
    }
    entries.push({
      afterMessageId: event.afterMessageId,
      message: {
        id: `service-request-${event.step.toLowerCase()}-${index}`,
        sender: "ASSISTANT",
        body: followUpMessage(context, event, locale),
        language: locale,
        createdAt: event.answeredAt,
      },
    });
  }

  // The pricing message is shown as soon as the four basic questions are
  // answered — right after the summary that closes them.
  if (isServiceRequestComplete(context.answers) || context.step === "SUMMARY") {
    const summaryEvent = context.answerLog.find((event) => event.step === "TARGETING");
    if (summaryEvent) {
      entries.push({
        afterMessageId: summaryEvent.afterMessageId,
        message: {
          id: SERVICE_REQUEST_ESTIMATE_ID,
          sender: "ASSISTANT",
          body: serviceRequestEstimate(context.answers, locale, { email: context.email }),
          language: locale,
          createdAt: summaryEvent.answeredAt,
        },
      });
    }
  }

  if (context.phoneError && context.step === "PHONE") {
    const last = context.answerLog[context.answerLog.length - 1];
    entries.push({
      afterMessageId: last ? last.afterMessageId : context.afterMessageId,
      message: {
        id: SERVICE_REQUEST_PHONE_ERROR_ID,
        sender: "ASSISTANT",
        body: locale === "ar" ? "الرقم غير صحيح، حاول مرة ثانية" : "That number is not valid, please try again",
        language: locale,
        createdAt: last ? last.answeredAt : context.startedAt,
      },
    });
  }

  const loaded = new Set(messages.map((message) => message.id));
  const placed = (anchor: string | null) =>
    entries
      .filter((entry) => entry.afterMessageId === anchor)
      .map((entry) => entry.message);
  const orphans = entries
    .filter((entry) => entry.afterMessageId === null || !loaded.has(entry.afterMessageId))
    .map((entry) => entry.message);
  // The clarification («pick one of these») is the newest thing on screen, so it
  // is always rendered last instead of being anchored to an older message.
  const clarificationEntry: ChatMessage[] = clarification.trim()
    ? [
        {
          id: SERVICE_REQUEST_CLARIFICATION_ID,
          sender: "ASSISTANT",
          body: clarification,
          language: locale,
          createdAt: new Date().toISOString(),
        },
      ]
    : [];
  return [...orphans, ...messages.flatMap((message) => [message, ...placed(message.id)]), ...clarificationEntry];
}

function formatTime(value: string, locale: Locale): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-IQ-u-nu-latn" : "en-GB", { hour: "2-digit", minute: "2-digit" }).format(date);
}
