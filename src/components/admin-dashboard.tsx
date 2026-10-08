"use client";

import { useEffect, useState } from "react";

import type { Locale } from "@/lib/domain/types";
import { dictionaries } from "@/lib/i18n/dictionaries";

interface AdminData {
  generatedAt: string;
  totals: {
    customers: number; newCustomers7d: number; activeProjects: number; overdueProjects: number;
    newRequests: number; activeCampaigns: number; reports30d: number; pendingAgentActions: number; urgentAlerts: number;
  };
  clients: Array<{ id: string; name: string; companyName?: string | null; email?: string | null; country?: string | null; status: string; createdAt: string }>;
  requests: Array<{ id: string; code: string; status: string; currency: string; totalMinor: number | string; createdByAgent?: string | null; createdAt: string; customerName: string; customerEmail?: string | null }>;
  projects: Array<{ id: string; code: string; title: string; status: string; progress: number; dueDate?: string | null; customerName: string; amountTotalMinor: number | string; internalCostMinor: number | string }>;
  campaigns: Array<{ id: string; name: string; platform: string; status: string; currency: string; totalBudgetMinor: number | string; monthlyBudgetMinor: number | string; spentMinor: number | string; syncStatus: string; customerName: string; updatedAt: string }>;
  reports: Array<{ id: string; title: string; type: string; status: string; customerName: string; createdAt: string }>;
  alerts: Array<{ id: string; severity: string; titleAr: string; titleEn: string; bodyAr?: string | null; bodyEn?: string | null; status: string; createdAt: string }>;
  agentActions: Array<{ id: string; agentKey: string; action: string; summary: string; reason?: string | null; riskLevel: string; requiresApproval: number; createdAt: string }>;
  financials: { collected30d: Array<{ currency: string; totalMinor: number | string }>; internalCost30d: Array<{ currency: string; totalMinor: number | string }> };
  integrations: { googleAds: { status: string }; whatsapp: { status: string }; payments: { status: string } };
}

export function AdminDashboard({ locale }: { locale: Locale }) {
  const ar = locale === "ar";
  const text = dictionaries[locale].dashboard;
  const [data, setData] = useState<AdminData | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/admin/dashboard", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Unable to load admin data.");
        setData(payload.data as AdminData);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Unable to load admin data.");
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  if (loading) return <div className="platform-card loading-card"><span className="loading-orbit" />{ar ? "جارٍ تحميل لوحة الإدارة…" : "Loading the admin dashboard…"}</div>;
  if (error) return <div className="setup-notice platform-notice" role="alert"><span className="setup-notice-icon">!</span><div><strong>{ar ? "تعذر تحميل بيانات الإدارة" : "Admin data could not be loaded"}</strong><p>{error}</p><p>{ar ? "تأكد من دور OWNER أو PARTNER وتطبيق ملف Supabase في لوحة المشروع." : "Confirm your OWNER or PARTNER role and apply the Supabase setup script."}</p></div></div>;
  if (!data) return null;

  const formatBuckets = (items: Array<{ currency: string; totalMinor: number | string }>) => {
    if (!items.length) return "—";
    return items.map((item) => formatMoney(item.totalMinor, item.currency, locale)).join(" · ");
  };
  const collected = formatBuckets(data.financials?.collected30d ?? []);
  const internalCosts = formatBuckets(data.financials?.internalCost30d ?? []);

  return (
    <div className="dashboard-content admin-dashboard">
      <section className="welcome-panel platform-card admin-welcome">
        <div><span className="eyebrow">{ar ? "مركز متابعة الوكالة" : "AGENCY CONTROL ROOM"}</span><h2>{ar ? "أهلًا بك في لوحة أفق" : "Welcome to the Ofoq control room"}</h2><p>{ar ? "ملخص تشغيلي للقراءة فقط من بيانات المنصة الفعلية. تظهر الأقسام فارغة حتى تسجل بيانات حقيقية." : "A read-only operational summary from platform data. Sections remain empty until real records exist."}</p></div>
        <span className="live-indicator"><i />{ar ? "بيانات مباشرة" : "Live data"}</span>
      </section>

      <section className="stat-grid admin-stat-grid" aria-label={ar ? "مؤشرات المنصة" : "Platform metrics"}>
        <AdminStat label={text.customers} value={data.totals.customers} caption={`${data.totals.newCustomers7d} ${ar ? "هذا الأسبوع" : "this week"}`} icon="◇" />
        <AdminStat label={text.activeProjects} value={data.totals.activeProjects} caption={`${data.totals.overdueProjects} ${ar ? "متأخر" : "overdue"}`} icon="◈" />
        <AdminStat label={text.requests} value={data.totals.newRequests} caption={ar ? "عروض بانتظار المتابعة" : "Offers awaiting follow-up"} icon="▤" />
        <AdminStat label={text.campaigns} value={data.totals.activeCampaigns} caption={ar ? "حملات مسجلة" : "Registered campaigns"} icon="⌁" />
        <AdminStat label={text.reports} value={data.totals.reports30d} caption={ar ? "آخر ٣٠ يومًا" : "Last 30 days"} icon="▧" />
      </section>

      <div className="admin-quick-links">
        <a href="#clients">{text.customers}<span>↗</span></a>
        <a href="#requests">{text.requests}<span>↗</span></a>
        <a href="#campaigns">{text.campaigns}<span>↗</span></a>
        <a href="#reports">{text.reports}<span>↗</span></a>
        <a href="#alerts">{text.alerts}<span>↗</span></a>
      </div>

      <div className="dashboard-columns admin-columns">
        <section className="platform-card content-card" id="clients">
          <div className="card-heading-row"><div><span className="eyebrow">01 / {text.customers}</span><h2>{ar ? "أحدث العملاء" : "Recent clients"}</h2></div><span className="mini-count">{data.totals.customers}</span></div>
          {data.clients.length === 0 ? <EmptyAdmin text={ar ? "لا يوجد عملاء مسجلون بعد. لن تظهر بيانات تجريبية هنا." : "No clients are registered yet. This space does not use demo records."} /> : <div className="table-list">{data.clients.map((client) => <article className="table-row" key={client.id}><div className="avatar-token">{client.name?.slice(0, 1) || "أ"}</div><div className="table-row-main"><strong>{client.name}</strong><span>{client.companyName || client.email || (ar ? "عميل" : "Client")}</span></div><span className={`status-pill status-${client.status.toLowerCase()}`}>{client.status}</span></article>)}</div>}
        </section>

        <section className="platform-card content-card" id="requests">
          <div className="card-heading-row"><div><span className="eyebrow">02 / {text.requests}</span><h2>{ar ? "الطلبات والعروض" : "Requests and offers"}</h2></div><span className="mini-count">{data.totals.newRequests}</span></div>
          {data.requests.length === 0 ? <EmptyAdmin text={ar ? "لا توجد طلبات أو عروض بعد." : "There are no requests or offers yet."} /> : <div className="compact-list">{data.requests.map((item) => <article className="compact-row" key={item.id}><div className="compact-row-copy"><strong>{item.code} · {item.customerName}</strong><span>{item.createdByAgent ? `${ar ? "أنشأه وكيل" : "Created by agent"}: ${item.createdByAgent}` : item.customerEmail || item.status}</span></div><div className="compact-row-side"><strong>{formatMoney(item.totalMinor, item.currency, locale)}</strong><StatusLabel status={item.status} locale={locale} /></div></article>)}</div>}
        </section>

        <section className="platform-card content-card" id="campaigns">
          <div className="card-heading-row"><div><span className="eyebrow">03 / {text.campaigns}</span><h2>{ar ? "الحملات الإعلانية" : "Advertising campaigns"}</h2></div><span className="integration-status">{ar ? "Google Ads غير مربوط" : "Google Ads not connected"}</span></div>
          {data.campaigns.length === 0 ? <EmptyAdmin text={ar ? "لا توجد حملات مسجلة. لا يتم جلب أو اختلاق بيانات إعلانية." : "No campaigns are recorded. Ad data is never fabricated."} /> : <div className="compact-list">{data.campaigns.map((campaign) => <article className="compact-row" key={campaign.id}><div className="compact-row-copy"><strong>{campaign.name}</strong><span>{campaign.customerName} · {campaign.platform.replaceAll("_", " ")}</span></div><div className="compact-row-side"><strong>{formatMoney(campaign.spentMinor, campaign.currency, locale)}</strong><StatusLabel status={campaign.status} locale={locale} /></div></article>)}</div>}
        </section>

        <section className="platform-card content-card" id="reports">
          <div className="card-heading-row"><div><span className="eyebrow">04 / {text.reports}</span><h2>{ar ? "التقارير الأخيرة" : "Recent reports"}</h2></div></div>
          {data.reports.length === 0 ? <EmptyAdmin text={ar ? "لا توجد تقارير محفوظة بعد." : "There are no saved reports yet."} /> : <div className="compact-list">{data.reports.map((report) => <article className="compact-row" key={report.id}><div className="compact-row-copy"><strong>{report.title}</strong><span>{report.customerName} · {report.type.replaceAll("_", " ")}</span></div><div className="compact-row-side"><StatusLabel status={report.status} locale={locale} /><time>{formatDate(report.createdAt, locale)}</time></div></article>)}</div>}
        </section>

        <section className="platform-card content-card" id="alerts">
          <div className="card-heading-row"><div><span className="eyebrow">05 / {text.alerts}</span><h2>{text.needsIntervention}</h2></div><span className="mini-count alert-count">{data.totals.urgentAlerts + data.totals.pendingAgentActions}</span></div>
          <div className="admin-alert-summary"><div><strong>{data.totals.urgentAlerts}</strong><span>{text.severityUrgent}</span></div><div><strong>{data.totals.pendingAgentActions}</strong><span>{text.pendingApprovals}</span></div></div>
          {data.alerts.length === 0 && data.agentActions.length === 0 ? <EmptyAdmin text={text.noAlerts} /> : <div className="compact-list">{data.alerts.map((alert) => <article className="alert-row" key={alert.id}><span className={`severity-dot severity-${alert.severity.toLowerCase()}`} /><div className="compact-row-copy"><strong>{ar ? alert.titleAr : alert.titleEn}</strong><span>{ar ? alert.bodyAr : alert.bodyEn}</span></div><time>{formatDate(alert.createdAt, locale)}</time></article>)}</div>}
        </section>

        <section className="platform-card content-card" id="agents">
          <div className="card-heading-row"><div><span className="eyebrow">06 / {text.agents}</span><h2>{text.latestActions}</h2></div></div>
          {data.agentActions.length === 0 ? <EmptyAdmin text={ar ? "لا توجد إجراءات مسجلة للوكلاء بعد." : "No agent actions have been logged yet."} /> : <div className="compact-list">{data.agentActions.map((action) => <article className="compact-row" key={action.id}><div className="compact-row-copy"><strong>{action.agentKey} · {action.action}</strong><span>{action.summary}{action.reason ? ` — ${action.reason}` : ""}</span></div><span className={`status-pill risk-${action.riskLevel.toLowerCase()}`}>{action.requiresApproval ? (ar ? "مراجعة مطلوبة" : "Review needed") : action.riskLevel}</span></article>)}</div>}
        </section>
      </div>

      <section className="platform-card finance-panel">
        <div><span className="eyebrow">07 / {ar ? "ملخص داخلي" : "INTERNAL SUMMARY"}</span><h2>{ar ? "المدفوعات والتكاليف" : "Payments and costs"}</h2><p>{ar ? "هذه البيانات داخلية ولا تظهر في بوابة العميل." : "This information is internal and is not shown in the client portal."}</p></div>
        <div className="finance-values"><div><span>{text.revenue} · 30d</span><strong>{collected}</strong></div><div><span>{text.expenses} · 30d</span><strong>{internalCosts}</strong></div></div>
      </section>

      <section className="integration-grid">
        <IntegrationCard label="Google Ads" status={data.integrations.googleAds.status} locale={locale} detail={ar ? "مهيأ للربط؛ لا يوجد حساب أو حملة فعالة مفترضة." : "Scaffolded; no account or active campaign is assumed."} />
        <IntegrationCard label="WhatsApp Business" status={data.integrations.whatsapp.status} locale={locale} detail={ar ? "معطل حتى ربط حساب Meta الرسمي." : "Disabled until an official Meta account is connected."} />
        <IntegrationCard label={ar ? "الدفع الإلكتروني" : "Online payments"} status={data.integrations.payments.status} locale={locale} detail={ar ? "الفواتير اليدوية فقط؛ لا تتم معالجة بطاقات." : "Manual invoices only; no card processing."} />
      </section>
      <p className="admin-generated-at">{ar ? "آخر تحديث" : "Updated"}: {formatDate(data.generatedAt, locale)}</p>
    </div>
  );
}

function AdminStat({ label, value, caption, icon }: { label: string; value: number; caption: string; icon: string }) {
  return <article className="stat-card platform-card"><div className="stat-card-top"><span className="stat-icon">{icon}</span><span className="stat-value">{value}</span></div><h3>{label}</h3><p>{caption}</p></article>;
}
function EmptyAdmin({ text }: { text: string }) { return <div className="empty-state"><span className="empty-state-mark">◇</span><p>{text}</p></div>; }
function StatusLabel({ status, locale }: { status: string; locale: Locale }) {
  const labels: Record<string, [string, string]> = { DRAFT: ["مسودة", "Draft"], SENT: ["أُرسل", "Sent"], APPROVED: ["موافق", "Approved"], ACTIVE: ["فعّال", "Active"], PAUSED: ["متوقف", "Paused"], COMPLETED: ["مكتمل", "Completed"], FAILED: ["فشل", "Failed"], PENDING_APPROVAL: ["بانتظار الموافقة", "Pending approval"], AWAITING_PAYMENT: ["بانتظار الدفع", "Awaiting payment"], IN_PROGRESS: ["قيد التنفيذ", "In progress"], IN_REVIEW: ["مراجعة", "In review"], OVERDUE: ["متأخر", "Overdue"], ISSUED: ["صادرة", "Issued"], PAID: ["مدفوعة", "Paid"] };
  return <span className={`status-pill status-${status.toLowerCase()}`}>{labels[status]?.[locale === "ar" ? 0 : 1] ?? status.replaceAll("_", " ")}</span>;
}
function IntegrationCard({ label, status, detail, locale }: { label: string; status: string; detail: string; locale: Locale }) {
  return <article className="platform-card integration-card"><div className="integration-card-head"><span className="integration-mark">↗</span><span className="integration-status">{status}</span></div><h3>{label}</h3><p>{detail}</p></article>;
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
