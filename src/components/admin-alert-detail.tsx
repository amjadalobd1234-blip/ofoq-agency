"use client";

import { useCallback, useEffect, useState } from "react";

import type { AdminAlertDetailsResponse } from "@/lib/admin/alert-types";
import { normalizeAdminAlertDetails } from "@/lib/admin/payload";
import type { Locale } from "@/lib/domain/types";

export function AdminAlertDetail({ alertId, locale }: { alertId: string; locale: Locale }) {
  const ar = locale === "ar";
  const [data, setData] = useState<AdminAlertDetailsResponse | null>(null);
  const [error, setError] = useState("");
  // Machine code, actionable hint and request id from the API. They turn
  // "the migration is not installed" into something the owner can act on, and
  // let a log line be found by its id.
  const [errorInfo, setErrorInfo] = useState<ApiErrorInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<"acknowledge" | "resolve" | "reply" | null>(null);
  const [notice, setNotice] = useState("");
  const [resolutionNote, setResolutionNote] = useState("");
  const [reply, setReply] = useState("");

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError("");
    setErrorInfo(null);
    try {
      const response = await fetch(`/api/admin/alerts/${encodeURIComponent(alertId)}`, { cache: "no-store", signal });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new AlertRequestError(readApiError(payload, "Unable to load alert."));
      setData(normalizeAdminAlertDetails(payload.data));
    } catch (reason) {
      if (signal?.aborted) return;
      if (reason instanceof AlertRequestError) {
        setError(reason.info.message);
        setErrorInfo(reason.info);
      } else {
        setError(reason instanceof Error ? reason.message : "Unable to load alert.");
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [alertId]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function act(action: "acknowledge" | "resolve" | "reply") {
    if (action === "reply" && !reply.trim()) return;
    setPending(action);
    setError("");
    setErrorInfo(null);
    setNotice("");
    try {
      const payload: Record<string, string> = { action };
      if (action === "resolve") payload.note = resolutionNote;
      if (action === "reply") {
        payload.body = reply;
        payload.language = locale;
      }
      const response = await fetch(`/api/admin/alerts/${encodeURIComponent(alertId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const responseBody = await response.json().catch(() => ({}));
      if (!response.ok) throw new AlertRequestError(readApiError(responseBody, "Unable to update alert."));
      setData(normalizeAdminAlertDetails(responseBody.data));
      if (action === "reply") setReply("");
      if (action === "resolve") setResolutionNote("");
      setNotice(actionNotice(action, locale));
    } catch (reason) {
      if (reason instanceof AlertRequestError) {
        setError(reason.info.message);
        setErrorInfo(reason.info);
      } else {
        setError(reason instanceof Error ? reason.message : "Unable to update alert.");
      }
    } finally {
      setPending(null);
    }
  }

  if (loading) return <div className="platform-card loading-card"><span className="loading-orbit" />{ar ? "جارٍ تحميل التنبيه…" : "Loading alert…"}</div>;
  if (error && !data) return <AlertError locale={locale} message={error} info={errorInfo} onRetry={() => void load()} />;
  if (!data) return null;

  const { alert } = data;
  const canReply = Boolean(data.conversation) && alert.status !== "RESOLVED";
  const title = ar ? alert.titleAr : alert.titleEn;
  const body = ar ? alert.bodyAr : alert.bodyEn;

  return (
    <div className="dashboard-content admin-alert-detail-page">
      <nav className="admin-alert-breadcrumb" aria-label={ar ? "مسار التنقل" : "Breadcrumb"}>
        <a href="/admin">{ar ? "لوحة الإدارة" : "Admin dashboard"}</a>
        <span>/</span>
        <a href="/admin/alerts">{ar ? "التنبيهات" : "Alerts"}</a>
        <span>/</span>
        <strong>{ar ? "تفاصيل التنبيه" : "Alert details"}</strong>
      </nav>

      {error && (
        <div className="setup-notice platform-notice" role="alert">
          <span className="setup-notice-icon">!</span>
          <div>
            <strong>{ar ? "تعذر تنفيذ الإجراء" : "Action could not be completed"}</strong>
            <p>{error}</p>
            <ErrorDetails locale={locale} info={errorInfo} />
          </div>
        </div>
      )}
      {notice && <p className="admin-action-notice" role="status">{notice}</p>}

      <section className="platform-card admin-alert-hero">
        <div className="admin-alert-hero-main">
          <div className="admin-alert-kicker">
            <span className={`severity-dot severity-${alert.severity.toLowerCase()}`} aria-hidden="true" />
            <span>{categoryLabel(alert.category, locale)}</span>
            <span className={`status-pill status-${alert.status.toLowerCase()}`}>{statusLabel(alert.status, locale)}</span>
          </div>
          <h2>{title}</h2>
          {body && <p>{body}</p>}
          <dl className="admin-alert-facts">
            <div><dt>{ar ? "ورد" : "Received"}</dt><dd>{formatDateTime(alert.createdAt, locale)}</dd></div>
            <div><dt>{ar ? "آخر تحديث" : "Last update"}</dt><dd>{formatDateTime(alert.updatedAt, locale)}</dd></div>
            {alert.acknowledgedAt && <div><dt>{ar ? "يتابعه" : "Acknowledged by"}</dt><dd>{alert.acknowledgedBy || formatDateTime(alert.acknowledgedAt, locale)}</dd></div>}
            {alert.resolvedAt && <div><dt>{ar ? "حُل في" : "Resolved"}</dt><dd>{formatDateTime(alert.resolvedAt, locale)}</dd></div>}
          </dl>
        </div>
        <div className="admin-alert-actions" aria-label={ar ? "إجراءات التنبيه" : "Alert actions"}>
          {alert.status === "NEW" && (
            <button type="button" className="admin-action-button" disabled={pending !== null} onClick={() => void act("acknowledge")}>
              {pending === "acknowledge" ? (ar ? "جارٍ التسجيل…" : "Saving…") : (ar ? "تأكيد المتابعة" : "Acknowledge")}
            </button>
          )}
          {alert.status !== "RESOLVED" && (
            <div className="admin-resolve-control">
              <label htmlFor="resolution-note">{ar ? "ملاحظة الحل (اختياري)" : "Resolution note (optional)"}</label>
              <textarea id="resolution-note" maxLength={2000} value={resolutionNote} onChange={(event) => setResolutionNote(event.target.value)} placeholder={ar ? "ما الذي تم إنجازه؟" : "What was completed?"} />
              <button type="button" className="admin-action-button admin-action-resolve" disabled={pending !== null} onClick={() => void act("resolve")}>
                {pending === "resolve" ? (ar ? "جارٍ الإغلاق…" : "Resolving…") : (ar ? "تم الحل" : "Resolve alert")}
              </button>
            </div>
          )}
          {alert.status === "RESOLVED" && <span className="admin-resolved-mark">✓ {ar ? "تم إغلاق التنبيه" : "Alert resolved"}</span>}
        </div>
      </section>

      <div className="admin-alert-detail-grid">
        <section className="platform-card admin-alert-context-card">
          <div className="card-heading-row"><div><span className="eyebrow">01 / {ar ? "العميل" : "CLIENT"}</span><h2>{ar ? "معلومات العميل" : "Client information"}</h2></div></div>
          {data.client ? (
            <dl className="admin-client-facts">
              <div><dt>{ar ? "الاسم" : "Name"}</dt><dd>{data.client.name || "—"}</dd></div>
              {data.client.companyName && <div><dt>{ar ? "الشركة" : "Company"}</dt><dd>{data.client.companyName}</dd></div>}
              {data.client.email && <div><dt>{ar ? "البريد" : "Email"}</dt><dd><a href={`mailto:${data.client.email}`}>{data.client.email}</a></dd></div>}
              {data.client.phone && <div><dt>{ar ? "الهاتف" : "Phone"}</dt><dd><a href={`tel:${data.client.phone}`}>{data.client.phone}</a></dd></div>}
            </dl>
          ) : <div className="empty-state"><span className="empty-state-mark">◇</span><p>{ar ? "لا توجد بطاقة عميل مرتبطة بهذا التنبيه." : "No client profile is linked to this alert."}</p></div>}
        </section>

        <section className="platform-card admin-alert-context-card">
          <div className="card-heading-row"><div><span className="eyebrow">02 / {ar ? "المتابعة" : "FOLLOW-UP"}</span><h2>{ar ? "سجل التنبيه" : "Alert trail"}</h2></div></div>
          {data.activities.length === 0 ? <div className="empty-state"><span className="empty-state-mark">◇</span><p>{ar ? "لا توجد إجراءات مسجلة بعد." : "No actions have been recorded yet."}</p></div> : <ol className="admin-activity-list">{data.activities.map((activity) => <li key={activity.id}><div><strong>{activityLabel(activity.action, locale)}</strong>{activity.summary && <span>{activity.summary}</span>}</div><time>{formatDateTime(activity.createdAt, locale)}</time></li>)}</ol>}
        </section>
      </div>

      <section className="platform-card admin-conversation-card">
        <div className="card-heading-row">
          <div><span className="eyebrow">03 / {ar ? "المحادثة" : "CONVERSATION"}</span><h2>{ar ? "سياق المحادثة مع العميل" : "Client conversation context"}</h2><p className="card-subtitle">{data.conversation ? `${data.conversation.subject || (ar ? "محادثة العميل" : "Client conversation")} · ${conversationStatus(data.conversation.status, locale)}` : (ar ? "لا توجد محادثة مرتبطة بهذا التنبيه." : "There is no conversation linked to this alert.")}</p></div>
          {data.conversation && <span className="status-pill status-in_progress">{conversationStatus(data.conversation.status, locale)}</span>}
        </div>

        {data.conversation ? (
          <>
            <div className="admin-conversation-messages">
              {data.messages.length === 0 ? <p className="admin-conversation-empty">{ar ? "لا توجد رسائل محفوظة في هذه المحادثة." : "There are no saved messages in this conversation."}</p> : data.messages.map((message) => (
                <article className={`admin-conversation-message sender-${message.sender.toLowerCase()}`} key={message.id}>
                  <div><strong>{senderLabel(message.sender, message.senderLabel, locale)}</strong><time>{formatDateTime(message.createdAt, locale)}</time></div>
                  <p>{message.body}</p>
                </article>
              ))}
            </div>
            <div className="admin-reply-composer">
              <label htmlFor="client-reply">{ar ? "الرد على العميل" : "Reply to client"}</label>
              <textarea id="client-reply" value={reply} maxLength={5000} disabled={!canReply || pending !== null} onChange={(event) => setReply(event.target.value)} placeholder={ar ? "اكتب رد الفريق الذي سيظهر للعميل في المحادثة…" : "Write the team reply that will appear in the client conversation…"} />
              <div><span>{reply.length}/5000</span><button type="button" className="admin-action-button" disabled={!canReply || !reply.trim() || pending !== null} onClick={() => void act("reply")}>{pending === "reply" ? (ar ? "جارٍ الإرسال…" : "Sending…") : (ar ? "إرسال الرد" : "Send reply")}</button></div>
              {!canReply && <small>{alert.status === "RESOLVED" ? (ar ? "لا يمكن الرد بعد حل التنبيه. أعد فتحه عبر تصعيد جديد من العميل عند الحاجة." : "Replies are unavailable after resolution. A new client escalation will reopen the case if needed.") : (ar ? "هذا التنبيه غير مرتبط بمحادثة قابلة للرد." : "This alert is not linked to a replyable conversation.")}</small>}
            </div>
          </>
        ) : <div className="empty-state"><span className="empty-state-mark">◇</span><p>{ar ? "يمكن متابعة هذا التنبيه من سجل الإجراءات أعلاه." : "Follow this alert from the activity trail above."}</p></div>}
      </section>

      {alert.resolutionNote && <section className="platform-card admin-resolution-card"><span className="eyebrow">{ar ? "آخر ملاحظة حل" : "LATEST RESOLUTION NOTE"}</span><p>{alert.resolutionNote}</p></section>}
    </div>
  );
}

function AlertError({ locale, message, info, onRetry }: { locale: Locale; message: string; info: ApiErrorInfo | null; onRetry: () => void }) {
  const ar = locale === "ar";
  return (
    <div className="setup-notice platform-notice" role="alert">
      <span className="setup-notice-icon">!</span>
      <div>
        <strong>{ar ? "تعذر فتح التنبيه" : "Alert could not be opened"}</strong>
        <p>{message}</p>
        <ErrorDetails locale={locale} info={info} />
        <p>
          <button type="button" className="owner-admin-link" onClick={onRetry}>{ar ? "إعادة المحاولة" : "Try again"}</button>{" "}
          <a className="owner-admin-link" href="/admin/alerts">{ar ? "كل التنبيهات" : "All alerts"}</a>{" "}
          <a className="owner-admin-link" href="/api/debug/alerts">{ar ? "تشخيص الاتصال بالـ API" : "Diagnose the API call"}</a>
        </p>
      </div>
    </div>
  );
}

/**
 * What the staff member needs to quote when they ask for help: the actionable
 * hint the API returned, the machine code and the request id of the log line.
 * `hint` and `code` are only ever sent by the staff-only routes.
 */
function ErrorDetails({ locale, info }: { locale: Locale; info: ApiErrorInfo | null }) {
  if (!info || (!info.hint && !info.code && !info.requestId)) return null;
  const ar = locale === "ar";
  return (
    <div className="admin-alert-error-details">
      {info.hint && <p>{info.hint}</p>}
      <p className="admin-alert-error-meta">
        {info.code && <span>{ar ? "الرمز" : "Code"}: {info.code}</span>}
        {info.requestId && <span>{ar ? "معرّف الطلب" : "Request"}: {info.requestId}</span>}
      </p>
    </div>
  );
}

interface ApiErrorInfo {
  message: string;
  code?: string;
  hint?: string;
  requestId?: string;
}

/** Carries the parsed API error so the catch blocks keep its details. */
class AlertRequestError extends Error {
  readonly info: ApiErrorInfo;
  constructor(info: ApiErrorInfo) {
    super(info.message);
    this.name = "AlertRequestError";
    this.info = info;
  }
}

function readApiError(payload: unknown, fallback: string): ApiErrorInfo {
  const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value : undefined);
  return {
    message: text(record.error) ?? fallback,
    code: text(record.code),
    hint: text(record.hint),
    requestId: text(record.requestId),
  };
}

function actionNotice(action: "acknowledge" | "resolve" | "reply", locale: Locale): string {
  const labels = {
    acknowledge: ["تم تسجيل متابعتك للتنبيه.", "Your follow-up has been recorded."],
    resolve: ["تم إغلاق التنبيه وتسجيل ملاحظة الحل.", "The alert was resolved and the note was recorded."],
    reply: ["أُرسل الرد للعميل في المحادثة.", "The reply was sent to the client conversation."],
  } as const;
  return labels[action][locale === "ar" ? 0 : 1];
}

function statusLabel(status: string, locale: Locale): string {
  const labels: Record<string, [string, string]> = { NEW: ["جديد", "New"], ACKNOWLEDGED: ["قيد المتابعة", "Acknowledged"], RESOLVED: ["تم الحل", "Resolved"] };
  return labels[status]?.[locale === "ar" ? 0 : 1] ?? status;
}

function categoryLabel(category: string, locale: Locale): string {
  const labels: Record<string, [string, string]> = { HUMAN_REQUEST: ["طلب فريق بشري", "Human handoff"], NEW_LEAD: ["طلب جديد", "New lead"], escalation: ["تصعيد", "Escalation"], support: ["دعم", "Support"], sales: ["مبيعات", "Sales"], billing: ["فوترة", "Billing"], delivery: ["تنفيذ", "Delivery"], integration: ["تكامل", "Integration"] };
  return labels[category]?.[locale === "ar" ? 0 : 1] ?? category.replaceAll("_", " ");
}

function activityLabel(action: string, locale: Locale): string {
  const labels: Record<string, [string, string]> = { "escalation.raised": ["تم رفع التنبيه", "Alert raised"], "alert.acknowledged": ["تم تأكيد المتابعة", "Alert acknowledged"], "alert.resolved": ["تم حل التنبيه", "Alert resolved"], "alert.replied_to_client": ["تم الرد على العميل", "Client replied to"] };
  return labels[action]?.[locale === "ar" ? 0 : 1] ?? action.replaceAll("_", " ");
}

function conversationStatus(status: string, locale: Locale): string {
  const labels: Record<string, [string, string]> = { OPEN: ["مفتوحة", "Open"], PENDING: ["بانتظار", "Pending"], CLOSED: ["مغلقة", "Closed"] };
  return labels[status]?.[locale === "ar" ? 0 : 1] ?? status;
}

function senderLabel(sender: string, label: string | null, locale: Locale): string {
  if (label) return label;
  const labels: Record<string, [string, string]> = { CLIENT: ["العميل", "Client"], STAFF: ["فريق أفق", "Ofoq team"], ASSISTANT: ["مساعد أفق", "Ofoq assistant"], AGENT: ["وكيل أفق", "Ofoq agent"], SYSTEM: ["النظام", "System"] };
  return labels[sender]?.[locale === "ar" ? 0 : 1] ?? sender;
}

function formatDateTime(value: string, locale: Locale): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-IQ-u-nu-latn" : "en-GB", { dateStyle: "medium", timeStyle: "short" }).format(date);
}
