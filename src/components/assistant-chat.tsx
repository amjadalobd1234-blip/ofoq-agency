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
}

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
  const tailRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/chat", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Unable to open chat.");
        setConversationId(payload.data?.conversationId || "");
        setMessages(Array.isArray(payload.data?.messages) ? payload.data.messages : []);
        setProviderAvailable(Boolean(payload.provider?.configured));
        setReady(true);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Unable to open chat.");
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

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
        result.reply as ChatMessage,
      ]);
      setProviderAvailable(Boolean(result.providerAvailable));
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
        {ready && <div className="chat-provider-note"><span>i</span>{providerAvailable ? (ar ? "مفتاح Gemini مهيأ؛ قد تُرسل الرسائل إلى Google لتوليد الرد، وقد نستخدم ردًا محليًا إذا تعذّرت الخدمة. لا تشارك كلمات مرور أو بيانات دفع." : "Gemini is configured. Messages may be sent to Google for generation, with a local fallback if unavailable. Do not share passwords or payment details.") : copy.providerOff}</div>}
        {error && <div className="form-notice form-notice-error chat-error" role="alert">{error}</div>}

        <div className="chat-messages" role="log" aria-live="polite" aria-relevant="additions text">
          {loading ? <div className="chat-loading"><span className="loading-orbit" />{ar ? "جارٍ فتح المحادثة…" : "Opening your conversation…"}</div> : messages.length === 0 ? <div className="chat-loading">{ar ? "لا توجد رسائل بعد. ابدأ بكتابة ما تحتاجه." : "No messages yet. Tell us what you need."}</div> : messages.map((message) => {
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
          <p className="chat-human-note">{ar ? "إذا كان الطلب غير واضح أو استثنائيًا، لن نخترع سعرًا أو وعدًا. هذه النسخة لا ترسل تنبيهًا فوريًا للفريق البشري؛ تُحفَظ رسائلك في حسابك." : "For unusual or unclear requests, we will not invent a price or promise. This version does not send an immediate human handoff alert; your messages are saved to your account."}</p>
        </article>
        <article className="platform-card chat-aside-card chat-privacy-card"><span className="privacy-icon">◇</span><div><strong>{ar ? "خصوصيتك أولًا" : "Privacy first"}</strong><p>{ar ? "لا ترسل بيانات بطاقة أو كلمة مرور أو معلومات حساسة في المحادثة." : "Do not share card details, passwords, or sensitive information in chat."}</p></div></article>
      </aside>
    </div>
  );
}

function formatTime(value: string, locale: Locale): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-IQ-u-nu-latn" : "en-GB", { hour: "2-digit", minute: "2-digit" }).format(date);
}
