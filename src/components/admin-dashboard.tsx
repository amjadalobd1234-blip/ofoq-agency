"use client";

import { useEffect, useState } from "react";

import { normalizeAdminDashboard, type AdminDashboardData } from "@/lib/admin/payload";
import type { Locale } from "@/lib/domain/types";
import { dictionaries } from "@/lib/i18n/dictionaries";

/** Offer statuses that still need a response from the agency. */
const NEW_OFFER_STATUSES = ["DRAFT", "SENT"];
/** Project statuses that count as active. Must match the RPC's `activeProjects` count. */
const ACTIVE_PROJECT_STATUSES = ["PLANNING", "IN_PROGRESS", "IN_REVIEW", "REVISIONS"];
/** Escalation categories raised by the assistant when a human is needed. */
const LEAD_CATEGORIES = ["NEW_LEAD", "HUMAN_REQUEST"];
type AdminTab = "overview" | "clients" | "requests" | "projects" | "campaigns" | "reports" | "alerts" | "agents";

const ADMIN_TABS: Array<{ id: AdminTab; ar: string; en: string }> = [
  { id: "overview", ar: "نظرة عامة", en: "Overview" },
  { id: "clients", ar: "العملاء", en: "Clients" },
  { id: "requests", ar: "الطلبات", en: "Requests" },
  { id: "projects", ar: "المشاريع", en: "Projects" },
  { id: "campaigns", ar: "الحملات", en: "Campaigns" },
  { id: "reports", ar: "التقارير", en: "Reports" },
  { id: "alerts", ar: "التنبيهات", en: "Alerts" },
  { id: "agents", ar: "موافقات الوكلاء", en: "Agent approvals" },
];

export function AdminDashboard({ locale }: { locale: Locale }) {
  const ar = locale === "ar";
  const text = dictionaries[locale].dashboard;
  const [data, setData] = useState<AdminDashboardData | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<AdminTab>("overview");

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/admin/dashboard", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          // eslint-disable-next-line no-console
          console.error("[AdminDashboard] /api/admin/dashboard failed:", {
            status: response.status,
            statusText: response.statusText,
            payload,
          });
          throw new Error(payload.error || "Unable to load admin data.");
        }
        setData(normalizeAdminDashboard(payload.data));
      })
      .catch((reason: unknown) => {
        // eslint-disable-next-line no-console
        console.error("[AdminDashboard] failed to load admin data:", reason);
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Unable to load admin data.");
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  if (loading) return <div className="platform-card loading-card"><span className="loading-orbit" />{ar ? "جارٍ تحميل لوحة الإدارة…" : "Loading the admin dashboard…"}</div>;
  if (error) return <div className="setup-notice platform-notice" role="alert"><span className="setup-notice-icon">!</span><div><strong>{ar ? "تعذر تحميل بيانات الإدارة" : "Admin data could not be loaded"}</strong><p>{error}</p><p>{ar ? "تأكد من دور OWNER أو PARTNER وتطبيق ملف Supabase في لوحة المشروع." : "Confirm your OWNER or PARTNER role and apply the Supabase setup script."}</p></div></div>;
  if (!data) return null;

  const newOffers = data.requests.filter((item) => NEW_OFFER_STATUSES.includes(item.status));
  const activeProjects = data.projects.filter((project) => ACTIVE_PROJECT_STATUSES.includes(project.status));
  const pendingActions = data.agentActions.filter((action) => Number(action.requiresApproval) === 1);
  // Client escalations the assistant raised: a person was requested, or the
  // client's need is understood. The fallback filter keeps the section working
  // if the deployed RPC returns the plain alerts list only.
  const leadRequests = data.leadRequests.length
    ? data.leadRequests
    : data.alerts.filter((alert) => LEAD_CATEGORIES.includes(alert.category));
  const criticalAlerts = data.totals.criticalAlerts ?? data.totals.urgentAlerts;
  const newLeadCount = data.totals.newLeads ?? leadRequests.length;

  const collected = formatBuckets(data.financials.collected30d, locale);
  const internalCosts = formatBuckets(data.financials.internalCost30d, locale);
  const hasRevenue = data.financials.collected30d.length > 0;

  return (
    <div className="dashboard-content admin-dashboard">
      <section className="welcome-panel platform-card admin-welcome">
        <div><span className="eyebrow">{ar ? "مركز متابعة الوكالة" : "AGENCY CONTROL ROOM"}</span><h2>{ar ? "أهلًا بك في لوحة أفق" : "Welcome to the Ofoq control room"}</h2><p>{ar ? "ملخص تشغيلي للقراءة فقط من بيانات المنصة الفعلية. تظهر الأقسام فارغة حتى تسجل بيانات حقيقية." : "A read-only operational summary from platform data. Sections remain empty until real records exist."}</p></div>
        <span className="live-indicator"><i />{ar ? "بيانات مباشرة" : "Live data"}</span>
      </section>

      <section className="stat-grid admin-stat-grid" aria-label={ar ? "مؤشرات المنصة" : "Platform metrics"}>
        <AdminStat label={ar ? "العملاء" : "Clients"} value={data.totals.customers} caption={`${data.totals.newCustomers7d} ${ar ? "جديد هذا الأسبوع" : "new this week"}`} icon="◇" />
        <AdminStat label={ar ? "المشاريع النشطة" : "Active projects"} value={data.totals.activeProjects} caption={`${data.totals.overdueProjects} ${ar ? "متأخر" : "overdue"}`} icon="◈" />
        <AdminStat label={ar ? "الإيرادات · ٣٠ يومًا" : "Revenue · 30 days"} value={hasRevenue ? collected : "—"} caption={hasRevenue ? (ar ? "المحصّل من الفواتير" : "Collected from invoices") : (ar ? "لا توجد مدفوعات خلال ٣٠ يومًا" : "No payments in the last 30 days")} icon="◎" small />
        <AdminStat label={ar ? "التنبيهات العاجلة" : "Urgent alerts"} value={data.totals.urgentAlerts} caption={`${criticalAlerts} ${ar ? "عاجلة الآن" : "critical now"} · ${newLeadCount} ${ar ? "طلب تواصل جديد" : "new contact requests"}`} icon="!" />
      </section>

      <nav className="admin-quick-links" role="tablist" aria-label={ar ? "تبويبات لوحة الإدارة" : "Admin dashboard tabs"}>
        {ADMIN_TABS.map((tab) => (
          <button
            type="button"
            role="tab"
            key={tab.id}
            aria-selected={activeTab === tab.id}
            className={activeTab === tab.id ? "is-active" : ""}
            onClick={() => setActiveTab(tab.id)}
          >
            {ar ? tab.ar : tab.en}
          </button>
        ))}
      </nav>

      <div className="dashboard-columns admin-columns" role="tabpanel">
        {(activeTab === "overview" || activeTab === "clients") && <section className="platform-card content-card" id="clients">
          <div className="card-heading-row"><div><span className="eyebrow">01 / {ar ? "العملاء" : "Clients"}</span><h2>{ar ? "أحدث العملاء" : "Recent clients"}</h2></div><span className="mini-count">{data.totals.customers}</span></div>
          {data.clients.length === 0 ? <EmptyAdmin text={ar ? "لا يوجد عملاء مسجلون بعد. لن تظهر بيانات تجريبية هنا." : "No clients are registered yet. This space does not use demo records."} /> : <div className="table-list">{data.clients.map((client) => <article className="table-row" key={client.id}><div className="avatar-token">{client.name?.slice(0, 1) || "أ"}</div><div className="table-row-main"><strong>{client.name}</strong><span>{client.companyName || client.email || (ar ? "عميل" : "Client")}</span></div><StatusLabel status={client.status} locale={locale} /></article>)}</div>}
        </section>}

        {(activeTab === "overview" || activeTab === "requests") && <section className="platform-card content-card" id="requests">
          <div className="card-heading-row"><div><span className="eyebrow">02 / {ar ? "الطلبات" : "Requests"}</span><h2>{ar ? "الطلبات الجديدة" : "New requests"}</h2><p className="card-subtitle">{ar ? "طلبات تواصل رفعها مساعد أفق + عروض بانتظار المتابعة." : "Contact requests raised by the Ofoq assistant, plus offers awaiting follow-up."}</p></div><span className="mini-count">{data.totals.newRequests + newLeadCount}</span></div>
          {leadRequests.length === 0 && newOffers.length === 0 ? <EmptyAdmin text={ar ? "لا توجد طلبات جديدة: لا تنبيهات تواصل من المساعد ولا عروض بحالة مسودة أو مُرسلة." : "No new requests: no assistant handoff alerts and no offers in draft or sent status."} /> : (
            <div className="compact-list">
              {leadRequests.map((lead) => <a className="alert-row alert-row-link" href={`/admin/alerts/${encodeURIComponent(lead.id)}`} key={lead.id}><span className={`severity-dot severity-${lead.severity.toLowerCase()}`} /><div className="compact-row-copy"><strong>{lead.customerName || (ar ? lead.titleAr : lead.titleEn)}</strong><span>{ar ? lead.bodyAr : lead.bodyEn}</span><span className="alert-meta">{lead.category === "HUMAN_REQUEST" ? (ar ? "طلب فريق بشري" : "Human handoff") : (ar ? "طلب جديد" : "New lead")}{lead.customerEmail ? ` · ${lead.customerEmail}` : ""} · {formatDate(lead.createdAt, locale)}</span></div><div className="compact-row-side"><span className="status-pill status-new">{ar ? "بانتظار الفريق" : "Awaiting team"}</span><time>{lead.conversationId ? `#${lead.conversationId.slice(0, 8)}` : ""}</time></div><span className="alert-row-open" aria-hidden="true">←</span></a>)}
              {newOffers.map((item) => <article className="compact-row" key={item.id}><div className="compact-row-copy"><strong>{item.code} · {item.customerName}</strong><span>{item.createdByAgent ? `${ar ? "أنشأه وكيل" : "Created by agent"}: ${item.createdByAgent}` : item.customerEmail || item.status}</span></div><div className="compact-row-side"><strong>{formatMoney(item.totalMinor, item.currency, locale)}</strong><StatusLabel status={item.status} locale={locale} /></div></article>)}
            </div>
          )}
        </section>}

        {(activeTab === "overview" || activeTab === "projects") && <section className="platform-card content-card" id="projects">
          <div className="card-heading-row"><div><span className="eyebrow">03 / {ar ? "المشاريع" : "Projects"}</span><h2>{ar ? "المشاريع النشطة" : "Active projects"}</h2></div><span className="mini-count">{data.totals.activeProjects}</span></div>
          {activeProjects.length === 0 ? <EmptyAdmin text={ar ? "لا توجد مشاريع نشطة حاليًا." : "There are no active projects right now."} /> : <div className="compact-list">{activeProjects.map((project) => <article className="compact-row" key={project.id}><div className="compact-row-copy"><strong>{project.code} · {project.title}</strong><span>{project.customerName}{project.dueDate ? ` · ${ar ? "الاستحقاق" : "Due"} ${formatDate(project.dueDate, locale)}` : ""}</span><div className="progress-track" aria-hidden="true"><span style={{ width: `${clampPercent(project.progress)}%` }} /></div></div><div className="compact-row-side"><strong>{clampPercent(project.progress)}%</strong><StatusLabel status={project.status} locale={locale} /></div></article>)}</div>}
        </section>}

        {(activeTab === "overview" || activeTab === "campaigns") && <section className="platform-card content-card" id="campaigns">
          <div className="card-heading-row"><div><span className="eyebrow">04 / {ar ? "الحملات" : "Campaigns"}</span><h2>{ar ? "الحملات الإعلانية" : "Advertising campaigns"}</h2></div><span className="integration-status">{ar ? "Google Ads غير مربوط" : "Google Ads not connected"}</span></div>
          {data.campaigns.length === 0 ? <EmptyAdmin text={ar ? "لا توجد حملات مسجلة. لا يتم جلب أو اختلاق بيانات إعلانية." : "No campaigns are recorded. Ad data is never fabricated."} /> : <div className="compact-list">{data.campaigns.map((campaign) => <article className="compact-row" key={campaign.id}><div className="compact-row-copy"><strong>{campaign.name}</strong><span>{campaign.customerName} · {campaign.platform.replaceAll("_", " ")}</span></div><div className="compact-row-side"><strong>{formatMoney(campaign.spentMinor, campaign.currency, locale)}</strong><StatusLabel status={campaign.status} locale={locale} /></div></article>)}</div>}
        </section>}

        {(activeTab === "overview" || activeTab === "reports") && <section className="platform-card content-card" id="reports">
          <div className="card-heading-row"><div><span className="eyebrow">05 / {ar ? "التقارير" : "Reports"}</span><h2>{ar ? "التقارير الأخيرة" : "Recent reports"}</h2></div><span className="mini-count">{data.totals.reports30d}</span></div>
          {data.reports.length === 0 ? <EmptyAdmin text={ar ? "لا توجد تقارير محفوظة بعد." : "There are no saved reports yet."} /> : <div className="compact-list">{data.reports.map((report) => <article className="compact-row" key={report.id}><div className="compact-row-copy"><strong>{report.title}</strong><span>{report.customerName} · {report.type.replaceAll("_", " ")}</span></div><div className="compact-row-side"><StatusLabel status={report.status} locale={locale} /><time>{formatDate(report.createdAt, locale)}</time></div></article>)}</div>}
        </section>}

        {(activeTab === "overview" || activeTab === "alerts") && <section className="platform-card content-card" id="alerts">
          <div className="card-heading-row"><div><span className="eyebrow">06 / {ar ? "التنبيهات" : "Alerts"}</span><h2>{text.needsIntervention}</h2></div><div className="card-heading-actions"><a className="subtle-link" href="/admin/alerts">{ar ? "كل التنبيهات" : "All alerts"}</a><span className="mini-count alert-count">{data.totals.urgentAlerts + data.totals.pendingAgentActions}</span></div></div>
          <div className="admin-alert-summary"><div><strong>{criticalAlerts}</strong><span>{text.severityUrgent}</span></div><div><strong>{data.totals.urgentAlerts - criticalAlerts}</strong><span>{ar ? "مهمة" : "Important"}</span></div><div><strong>{newLeadCount}</strong><span>{ar ? "طلب تواصل" : "Contact requests"}</span></div><div><strong>{data.totals.pendingAgentActions}</strong><span>{text.pendingApprovals}</span></div></div>
          {data.alerts.length === 0 ? <EmptyAdmin text={text.noAlerts} /> : <div className="compact-list">{data.alerts.map((alert) => <a className="alert-row alert-row-link" href={`/admin/alerts/${encodeURIComponent(alert.id)}`} key={alert.id}><span className={`severity-dot severity-${alert.severity.toLowerCase()}`} /><div className="compact-row-copy"><strong>{ar ? alert.titleAr : alert.titleEn}</strong><span>{ar ? alert.bodyAr : alert.bodyEn}</span>{alert.category || alert.customerName ? <span className="alert-meta">{[alertCategoryLabel(alert.category, locale), alert.customerName].filter(Boolean).join(" · ")}</span> : null}</div><time>{formatDate(alert.createdAt, locale)}</time><span className="alert-row-open" aria-hidden="true">←</span></a>)}</div>}
        </section>}

        {(activeTab === "overview" || activeTab === "agents") && <section className="platform-card content-card" id="agents">
          <div className="card-heading-row"><div><span className="eyebrow">07 / {ar ? "الوكلاء" : "Agents"}</span><h2>{ar ? "إجراءات الوكلاء المعلّقة" : "Pending agent actions"}</h2></div><span className="mini-count">{data.totals.pendingAgentActions}</span></div>
          {pendingActions.length === 0 ? <EmptyAdmin text={ar ? "لا توجد إجراءات تنتظر موافقتك." : "No agent actions are waiting for your approval."} /> : <div className="compact-list">{pendingActions.map((action) => <article className="compact-row" key={action.id}><div className="compact-row-copy"><strong>{action.agentKey} · {action.action}</strong><span>{action.summary}{action.reason ? ` — ${action.reason}` : ""}</span></div><span className={`status-pill risk-${action.riskLevel.toLowerCase()}`}>{ar ? "تحتاج موافقتك" : "Needs approval"}</span></article>)}</div>}
        </section>}
      </div>

      {activeTab === "overview" && <>
      <section className="platform-card finance-panel">
        <div><span className="eyebrow">08 / {ar ? "ملخص داخلي" : "INTERNAL SUMMARY"}</span><h2>{ar ? "المدفوعات والتكاليف" : "Payments and costs"}</h2><p>{ar ? "هذه البيانات داخلية ولا تظهر في بوابة العميل." : "This information is internal and is not shown in the client portal."}</p></div>
        <div className="finance-values"><div><span>{text.revenue} · 30d</span><strong>{collected}</strong></div><div><span>{text.expenses} · 30d</span><strong>{internalCosts}</strong></div></div>
      </section>

      <section className="integration-grid">
        <IntegrationCard label="Google Ads" status={data.integrations.googleAds.status} locale={locale} detail={ar ? "مهيأ للربط؛ لا يوجد حساب أو حملة فعالة مفترضة." : "Scaffolded; no account or active campaign is assumed."} />
        <IntegrationCard label="WhatsApp Business" status={data.integrations.whatsapp.status} locale={locale} detail={ar ? "معطل حتى ربط حساب Meta الرسمي." : "Disabled until an official Meta account is connected."} />
        <IntegrationCard label={ar ? "الدفع الإلكتروني" : "Online payments"} status={data.integrations.payments.status} locale={locale} detail={ar ? "الفواتير اليدوية فقط؛ لا تتم معالجة بطاقات." : "Manual invoices only; no card processing."} />
      </section>
      <p className="admin-generated-at">{ar ? "آخر تحديث" : "Updated"}: {formatDate(data.generatedAt, locale)}</p>
      </>}
    </div>
  );
}

function AdminStat({ label, value, caption, icon, small = false }: { label: string; value: number | string; caption: string; icon: string; small?: boolean }) {
  return <article className="stat-card platform-card"><div className="stat-card-top"><span className="stat-icon">{icon}</span><span className={`stat-value${small ? " stat-value-text" : ""}`}>{value}</span></div><h3>{label}</h3><p>{caption}</p></article>;
}
function EmptyAdmin({ text }: { text: string }) { return <div className="empty-state"><span className="empty-state-mark">◇</span><p>{text}</p></div>; }
/** Human label for an alert category, so the owner sees who needs them. */
function alertCategoryLabel(category: string | undefined, locale: Locale): string {
  const labels: Record<string, [string, string]> = {
    HUMAN_REQUEST: ["طلب فريق بشري", "Human handoff"],
    NEW_LEAD: ["طلب جديد", "New lead"],
    escalation: ["تصعيد", "Escalation"],
    support: ["دعم", "Support"],
    sales: ["مبيعات", "Sales"],
    billing: ["فوترة", "Billing"],
    delivery: ["تنفيذ", "Delivery"],
    integration: ["تكامل", "Integration"],
  };
  if (!category) return "";
  return labels[category]?.[locale === "ar" ? 0 : 1] ?? category.replaceAll("_", " ");
}
function StatusLabel({ status, locale }: { status: string; locale: Locale }) {
  const labels: Record<string, [string, string]> = {
    ACTIVE: ["فعّال", "Active"], LEAD: ["عميل محتمل", "Lead"], PAUSED: ["متوقف", "Paused"], ARCHIVED: ["مؤرشف", "Archived"],
    PENDING: ["معلّق", "Pending"], SUSPENDED: ["موقوف", "Suspended"], DELETED: ["محذوف", "Deleted"],
    DRAFT: ["مسودة", "Draft"], SENT: ["أُرسل", "Sent"], APPROVED: ["موافق", "Approved"],
    COMPLETED: ["مكتمل", "Completed"], CANCELLED: ["ملغى", "Cancelled"], FAILED: ["فشل", "Failed"],
    PLANNING: ["تخطيط", "Planning"], PENDING_APPROVAL: ["بانتظار الموافقة", "Pending approval"], AWAITING_APPROVAL: ["بانتظار الموافقة", "Awaiting approval"],
    AWAITING_PAYMENT: ["بانتظار الدفع", "Awaiting payment"], IN_PROGRESS: ["قيد التنفيذ", "In progress"], IN_REVIEW: ["مراجعة", "In review"],
    REVISIONS: ["تعديلات", "Revisions"], OVERDUE: ["متأخر", "Overdue"], ISSUED: ["صادرة", "Issued"], PAID: ["مدفوعة", "Paid"],
  };
  return <span className={`status-pill status-${status.toLowerCase()}`}>{labels[status]?.[locale === "ar" ? 0 : 1] ?? status.replaceAll("_", " ")}</span>;
}
function IntegrationCard({ label, status, detail, locale }: { label: string; status: string; detail: string; locale: Locale }) {
  return <article className="platform-card integration-card"><div className="integration-card-head"><span className="integration-mark">↗</span><span className="integration-status">{status}</span></div><h3>{label}</h3><p>{detail}</p></article>;
}
function clampPercent(value: number | null | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : 0;
}
function formatBuckets(items: Array<{ currency: string; totalMinor: number | string }>, locale: Locale): string {
  if (!items.length) return "—";
  return items.map((item) => formatMoney(item.totalMinor, item.currency, locale)).join(" · ");
}
function formatMoney(value: number | string, currency: string, locale: Locale): string {
  const amount = Number(value || 0) / 100;
  try { return new Intl.NumberFormat(locale === "ar" ? "ar-IQ-u-nu-latn" : "en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format(amount); }
  catch { return `${amount.toFixed(2)} ${currency}`; }
}
function formatDate(value: string, locale: Locale): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-IQ-u-nu-latn" : "en-GB", { dateStyle: "medium" }).format(date);
}
