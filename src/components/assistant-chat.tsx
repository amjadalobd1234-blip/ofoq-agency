"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

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
}

const SERVICE_REQUEST_STORAGE_KEY = "ofoq:chat:service-request";
const SERVICE_REQUEST_WELCOME_ID = "service-request-welcome";
/** First assistant message of a service request. Displayed in the chat only; it is not saved to the conversation. */
const SERVICE_REQUEST_WELCOME: Record<Locale, string> = {
  ar: "تمام! خلينا نجهّز طلب خدمة. أول شي: شنو نوع الخدمة اللي تحتاجها؟\n(تصميم / إعلانات / سوشيال ميديا / محتوى / SEO / غير ذلك)",
  en: "Great! Let's get a service request ready. First: what type of service do you need?\n(Design / Ads / Social media / Content / SEO / Other)",
};

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

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  }

  // The service-request welcome is displayed, not saved: it sits after the message that was last when the request started.
  const visibleMessages = serviceRequest ? withServiceWelcome(messages, serviceRequest, locale) : messages;

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

        {intent === "service_request" && <div className="chat-context-note">{ar ? "ابدأ بوصف الخدمة أو النتيجة التي تبحث عنها. لا تحتاج إلى تعبئة نموذج طويل." : "Describe the service or outcome you need. There is no long form to complete."}</div>}
        {ready && <div className="chat-provider-note"><span>i</span>{providerAvailable ? (ar ? "المساعد متصل بمزودي الذكاء الاصطناعي (Groq، Gemini، Cohere وغيرها). قد تُرسل رسائل المحادثة إلى المزود لتوليد الرد، ونعود إلى الردود المحلية إذا تعذّرت الخدمة. لا تشارك كلمات مرور أو بيانات دفع." : "The assistant is connected to AI providers (Groq, Gemini, Cohere and others). Conversation messages may be sent to a provider for generation, with local replies as a fallback. Do not share passwords or payment details.") : copy.providerOff}</div>}
        {escalated && <div className="chat-escalation-note" role="status"><span>✔</span>{ar ? "تم تحويل محادثتك إلى فريق أفق البشري: أُنشئ تنبيه في لوحة الوكالة وتم إشعار المالك. سيتواصل معك أحد أعضاء الفريق." : "Your conversation has been handed over to the Ofoq human team: an alert was created in the agency control room and the owner was notified. A team member will contact you."}</div>}
        {error && <div className="form-notice form-notice-error chat-error" role="alert">{error}</div>}

        <div className="chat-messages" role="log" aria-live="polite" aria-relevant="additions text">
          {loading ? <div className="chat-loading"><span className="loading-orbit" />{ar ? "جارٍ فتح المحادثة…" : "Opening your conversation…"}</div> : visibleMessages.length === 0 ? <div className="chat-loading">{ar ? "لا توجد رسائل بعد. ابدأ بكتابة ما تحتاجه." : "No messages yet. Tell us what you need."}</div> : visibleMessages.map((message) => {
            const own = message.sender === "CLIENT";
            return <article className={`chat-message ${own ? "chat-message-client" : "chat-message-assistant"}`} key={message.id}>
              {!own && <span className="message-sender">{message.sender === "STAFF" ? (ar ? "فريق أفق" : "Ofoq team") : copy.title}</span>}
              <p dir={message.language === "en" ? "ltr" : message.language === "ar" ? "rtl" : undefined}>{message.body}</p>

              <time>{formatTime(message.createdAt, locale)}</time>
            </article>;
          })}
          {sending && <div className="chat-message chat-message-assistant chat-typing"><span className="typing-dots"><i /><i /><i /></span><span>{copy.typing}</span></div>}
          <div ref={tailRef} />
        </div>

        {messages.length <= 1 && !loading && <div className="chat-quick-replies" aria-label={ar ? "اقتراحات للبدء" : "Suggested prompts"}>{quickReplies.map((reply) => <button type="button" key={reply} onClick={() => setInput(reply)}>{reply}</button>)}</div>}

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
  };
  try {
    window.sessionStorage.setItem(SERVICE_REQUEST_STORAGE_KEY, JSON.stringify(context));
  } catch {
    // Storage can be blocked (private mode, browser policy); the request still works for this page view.
  }
  return context;
}

function readServiceRequest(): ServiceRequestContext | null {
  try {
    const stored = JSON.parse(window.sessionStorage.getItem(SERVICE_REQUEST_STORAGE_KEY) ?? "null");
    return stored?.intent === "service_request" && typeof stored.conversationId === "string" ? stored : null;
  } catch {
    return null;
  }
}

/** Places the welcome after its anchor message, or first when the anchor is no longer in the loaded history. */
function withServiceWelcome(messages: ChatMessage[], context: ServiceRequestContext, locale: Locale): ChatMessage[] {
  const welcome: ChatMessage = { id: SERVICE_REQUEST_WELCOME_ID, sender: "ASSISTANT", body: SERVICE_REQUEST_WELCOME[locale], language: locale, createdAt: context.startedAt };
  const anchor = messages.findIndex((message) => message.id === context.afterMessageId);
  const position = anchor === -1 ? 0 : anchor + 1;
  return [...messages.slice(0, position), welcome, ...messages.slice(position)];
}

function formatTime(value: string, locale: Locale): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-IQ-u-nu-latn" : "en-GB", { hour: "2-digit", minute: "2-digit" }).format(date);
}
