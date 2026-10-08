"use client";

import { useEffect, useState } from "react";

import type { Locale } from "@/lib/domain/types";
import { dictionaries } from "@/lib/i18n/dictionaries";

interface Project {
  id: string; code: string; title: string; titleEn?: string | null; brief?: string | null;
  status: string; progress: number; currency: string; amountTotalMinor: number | string;
  startDate?: string | null; dueDate?: string | null;
  tasks?: Array<{ id: string; title: string; titleEn?: string | null; status: string; dueDate?: string | null }>;
}
interface Offer {
  id: string; code: string; status: string; currency: string; totalMinor: number | string;
  validUntil?: string | null; clientNote?: string | null;
  items?: Array<{ descriptionAr: string; descriptionEn?: string | null; billingType: string; months?: number | null }>;
}
interface Invoice {
  id: string; number: string; currency: string; totalMinor: number | string; amountPaidMinor: number | string;
  status: string; issuedAt?: string | null; dueAt?: string | null; notes?: string | null;
}
interface Campaign {
  id: string; name: string; platform: string; status: string; currency: string;
  totalBudgetMinor: number | string; spentMinor: number | string; syncStatus: string;
}
interface PortalData {
  customer: { id: string; name: string; companyName?: string | null; email?: string | null; locale: string } | null;
  projects: Project[]; offers: Offer[]; invoices: Invoice[];
  payments: Array<{ id: string; invoiceId?: string | null; amountMinor: number | string; refundedMinor: number | string; currency: string; method: string; status: string; paidAt?: string | null; createdAt: string }>;
  subscriptions: Array<{ id: string; planName: string; amountMinor: number | string; currency: string; status: string; periodEnd?: string | null; nextRenewalAt?: string | null }>,
  campaigns: Campaign[];
  reports: Array<{ id: string; title: string; summary: string; type: string; createdAt: string }>;
  files: Array<{ id: string; name: string; kind?: string | null; sizeBytes: number | string; createdAt: string }>;
}

export function ClientDashboard({ locale }: { locale: Locale }) {
  const ar = locale === "ar";
  const copy = dictionaries[locale];
  const portal = copy.portal;
  const [data, setData] = useState<PortalData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/dashboard", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Unable to load account data.");
        setData(payload.data as PortalData);
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setError(reason instanceof Error ? reason.message : "Unable to load account data.");
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  if (loading) return <div className="platform-card loading-card"><span className="loading-orbit" />{ar ? "جارٍ تحميل حسابك…" : "Loading your account…"}</div>;
  if (error) return <div className="setup-notice platform-notice" role="alert"><span className="setup-notice-icon">!</span><div><strong>{ar ? "تعذر تحميل بيانات الحساب" : "Account data could not be loaded"}</strong><p>{error}</p><p>{ar ? "تحقق من إعداد Supabase وتطبيق ملف السياسات في docs/setup/supabase-setup.sql." : "Check Supabase settings and apply the policies in docs/setup/supabase-setup.sql."}</p></div></div>;
  if (!data) return null;

  const activeProjects = data.projects.filter((project) => !["COMPLETED", "CANCELLED"].includes(project.status));
  const pendingOffers = data.offers.filter((offer) => ["DRAFT", "SENT"].includes(offer.status));
  const unpaidInvoices = data.invoices.filter((invoice) => !["PAID", "CANCELLED", "REFUNDED"].includes(invoice.status));

  return (
    <div className="dashboard-content">
      {!data.customer && <div className="form-notice form-notice-error">{ar ? "لم يكتمل ملف العميل بعد. تواصل مع فريق أفق للمساعدة." : "Your client profile is not ready yet. Contact the Ofoq team for help."}</div>}

      <section className="welcome-panel platform-card">
        <div>
          <span className="eyebrow">{ar ? "مساحتك الخاصة" : "YOUR PRIVATE SPACE"}</span>
          <h2>{ar ? `مرحبًا${data.customer?.name ? `، ${data.customer.name}` : " بك"}` : `Welcome${data.customer?.name ? `, ${data.customer.name}` : ""}`}</h2>
          <p>{ar ? "هنا تتابع المشاريع والطلبات والفواتير، وتجد كل تحديث في مكان واحد." : "Follow your projects, requests and invoices, with updates gathered in one place."}</p>
        </div>
        <a className="button button-gold" href="/chat?intent=service_request"><span>{ar ? "اطلب خدمة جديدة" : "Request a new service"}</span><span className="button-arrow" aria-hidden="true">↗</span></a>
      </section>

      <section className="stat-grid" aria-label={ar ? "ملخص الحساب" : "Account summary"}>
        <StatCard label={portal.projects} value={activeProjects.length} hint={ar ? "قيد العمل أو التخطيط" : "In progress or planning"} icon="◈" />
        <StatCard label={portal.offers} value={pendingOffers.length} hint={ar ? "تحتاج مراجعتك" : "Waiting for your review"} icon="◇" />
        <StatCard label={portal.invoices} value={unpaidInvoices.length} hint={ar ? "مفتوحة أو مستحقة" : "Open or due"} icon="▤" />
        <StatCard label={portal.subscriptions} value={data.subscriptions.filter((item) => item.status === "ACTIVE").length} hint={ar ? "اشتراكات فعالة" : "Active subscriptions"} icon="↻" />
      </section>

      <div className="dashboard-columns">
        <section className="platform-card content-card" aria-labelledby="projects-heading">
          <div className="card-heading-row"><div><span className="eyebrow">01 / {portal.overview}</span><h2 id="projects-heading">{portal.projects}</h2></div><a className="subtle-link" href="/chat">{ar ? "اسأل مساعد أفق" : "Ask Ofoq"} ↗</a></div>
          {data.projects.length === 0 ? <EmptyState text={portal.noProjects} action={ar ? "ابدأ محادثة" : "Start a conversation"} href="/chat" /> : (
            <div className="project-list">
              {data.projects.map((project) => (
                <article className="project-row" key={project.id}>
                  <div className="project-row-main">
                    <div className="project-row-title"><div><h3>{ar ? project.title : project.titleEn || project.title}</h3><span className="project-code">{project.code}</span></div><StatusPill status={project.status} locale={locale} /></div>
                    <div className="progress-meta"><span>{portal.progress}</span><strong>{Math.min(100, Math.max(0, Number(project.progress) || 0))}%</strong></div>
                    <div className="progress-track"><span style={{ width: `${Math.min(100, Math.max(0, Number(project.progress) || 0))}%` }} /></div>
                    {project.dueDate && <p className="row-meta">{portal.dueDate}: {formatDate(project.dueDate, locale)}</p>}
                    {project.tasks && project.tasks.length > 0 && <p className="row-meta">{ar ? `المراحل الظاهرة لك: ${project.tasks.filter((task) => task.status === "DONE").length} من ${project.tasks.length}` : `Visible stages: ${project.tasks.filter((task) => task.status === "DONE").length} of ${project.tasks.length}`}</p>}
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        <section className="platform-card content-card" aria-labelledby="offers-heading">
          <div className="card-heading-row"><div><span className="eyebrow">02 / {copy.dashboard.requests}</span><h2 id="offers-heading">{portal.offers}</h2></div><span className="mini-count">{data.offers.length}</span></div>
          {data.offers.length === 0 ? <EmptyState text={portal.noOffers} /> : (
            <div className="compact-list">
              {data.offers.map((offer) => <article className="compact-row" key={offer.id}>
                <div className="compact-row-copy"><strong>{offer.code}</strong><span>{offer.items?.[0] ? (ar ? offer.items[0].descriptionAr : offer.items[0].descriptionEn || offer.items[0].descriptionAr) : (ar ? "عرض مخصص" : "Custom offer")}</span></div>
                <div className="compact-row-side"><strong>{formatMoney(offer.totalMinor, offer.currency, locale)}</strong><StatusPill status={offer.status} locale={locale} /></div>
              </article>)}
            </div>
          )}
        </section>

        <section className="platform-card content-card" aria-labelledby="invoices-heading">
          <div className="card-heading-row"><div><span className="eyebrow">03 / {portal.overview}</span><h2 id="invoices-heading">{portal.invoices}</h2></div><span className="mini-count">{data.invoices.length}</span></div>
          {data.invoices.length === 0 ? <EmptyState text={portal.noInvoices} /> : (
            <div className="compact-list">
              {data.invoices.map((invoice) => <article className="compact-row" key={invoice.id}>
                <div className="compact-row-copy"><strong>{invoice.number}</strong><span>{invoice.dueAt ? `${portal.dueDate}: ${formatDate(invoice.dueAt, locale)}` : invoice.notes || (ar ? "فاتورة أفق" : "Ofoq invoice")}</span></div>
                <div className="compact-row-side"><strong>{formatMoney(invoice.totalMinor, invoice.currency, locale)}</strong><StatusPill status={invoice.status} locale={locale} /></div>
              </article>)}
            </div>
          )}
          <div className="payment-disclaimer"><span aria-hidden="true">◇</span>{ar ? "الدفع الإلكتروني غير مفعّل في هذه النسخة. لا تُدخل بيانات بطاقتك؛ ستظهر تعليمات الدفع اليدوي بعد إصدار الفاتورة." : "Online checkout is not enabled in this release. Never enter card details here; manual payment instructions will accompany an issued invoice."}</div>
        </section>

        <section className="platform-card content-card" aria-labelledby="payments-heading">
          <div className="card-heading-row"><div><span className="eyebrow">04 / {portal.overview}</span><h2 id="payments-heading">{ar ? "سجل الدفعات" : "Payment history"}</h2></div><span className="mini-count">{data.payments.length}</span></div>
          {data.payments.length === 0 ? <EmptyState text={ar ? "لا توجد دفعات مسجلة." : "No payments have been recorded."} /> : <div className="compact-list">{data.payments.map((payment) => <article className="compact-row" key={payment.id}><div className="compact-row-copy"><strong>{payment.invoiceId ? (ar ? "دفعة فاتورة" : "Invoice payment") : (ar ? "دفعة" : "Payment")}</strong><span>{payment.method.replaceAll("_", " ")}{payment.paidAt ? ` · ${formatDate(payment.paidAt, locale)}` : ""}</span></div><div className="compact-row-side"><strong>{formatMoney(payment.amountMinor, payment.currency, locale)}</strong><StatusPill status={payment.status} locale={locale} /></div></article>)}</div>}
        </section>

        <section className="platform-card content-card" aria-labelledby="campaigns-heading">
          <div className="card-heading-row"><div><span className="eyebrow">04 / {copy.dashboard.reports}</span><h2 id="campaigns-heading">{copy.dashboard.campaigns}</h2></div></div>
          {data.campaigns.length === 0 ? <EmptyState text={ar ? "لا توجد حملات مرتبطة بحسابك بعد." : "No campaigns are linked to your account yet."} /> : (
            <div className="compact-list">{data.campaigns.map((campaign) => <article className="compact-row" key={campaign.id}>
              <div className="compact-row-copy"><strong>{campaign.name}</strong><span>{campaign.platform.replaceAll("_", " ")} · {campaign.syncStatus === "DISABLED" ? (ar ? "التكامل غير مربوط" : "Integration not connected") : campaign.syncStatus}</span></div>
              <div className="compact-row-side"><strong>{formatMoney(campaign.spentMinor, campaign.currency, locale)}</strong><StatusPill status={campaign.status} locale={locale} /></div>
            </article>)}</div>
          )}
        </section>

        <section className="platform-card content-card reports-card" aria-labelledby="reports-heading">
          <div className="card-heading-row"><div><span className="eyebrow">05 / {portal.overview}</span><h2 id="reports-heading">{portal.reports}</h2></div></div>
          {data.reports.length === 0 ? <EmptyState text={portal.noReports} /> : <div className="compact-list">{data.reports.map((report) => <article className="compact-row" key={report.id}><div className="compact-row-copy"><strong>{report.title}</strong><span>{report.summary}</span></div><time className="row-meta">{formatDate(report.createdAt, locale)}</time></article>)}</div>}
        </section>
      </div>
    </div>
  );
}

function StatCard({ label, value, hint, icon }: { label: string; value: number; hint: string; icon: string }) {
  return <article className="stat-card platform-card"><div className="stat-card-top"><span className="stat-icon" aria-hidden="true">{icon}</span><span className="stat-value">{value}</span></div><h3>{label}</h3><p>{hint}</p></article>;
}

function EmptyState({ text, action, href }: { text: string; action?: string; href?: string }) {
  return <div className="empty-state"><span className="empty-state-mark" aria-hidden="true">◇</span><p>{text}</p>{action && href && <a className="subtle-link" href={href}>{action} ↗</a>}</div>;
}

function StatusPill({ status, locale }: { status: string; locale: Locale }) {
  const ar = locale === "ar";
  const labels: Record<string, [string, string]> = {
    DRAFT: ["مسودة", "Draft"], SENT: ["أُرسل", "Sent"], APPROVED: ["موافق عليه", "Approved"],
    REJECTED: ["مرفوض", "Declined"], EXPIRED: ["منتهي", "Expired"],
    AWAITING_APPROVAL: ["بانتظار الموافقة", "Awaiting approval"], AWAITING_PAYMENT: ["بانتظار الدفع", "Awaiting payment"],
    PLANNING: ["تخطيط", "Planning"], IN_PROGRESS: ["قيد التنفيذ", "In progress"], IN_REVIEW: ["مراجعة", "In review"],
    REVISIONS: ["تعديلات", "Revisions"], COMPLETED: ["مكتمل", "Completed"], CANCELLED: ["ملغى", "Cancelled"],
    ISSUED: ["مُصدرة", "Issued"], PARTIALLY_PAID: ["مدفوعة جزئيًا", "Part-paid"], PAID: ["مدفوعة", "Paid"], OVERDUE: ["متأخرة", "Overdue"],
    ACTIVE: ["فعّال", "Active"], PAUSED: ["متوقف مؤقتًا", "Paused"], PAST_DUE: ["متأخر", "Past due"], REFUNDED: ["مستردة", "Refunded"],
    SUCCEEDED: ["ناجحة", "Succeeded"], PENDING: ["قيد الانتظار", "Pending"], FAILED: ["فشلت", "Failed"],
  };
  const label = labels[status]?.[ar ? 0 : 1] ?? status.replaceAll("_", " ");
  return <span className={`status-pill status-${status.toLowerCase()}`}>{label}</span>;
}

function formatMoney(value: number | string, currency: string, locale: Locale): string {
  const amount = Number(value || 0) / 100;
  try {
    return new Intl.NumberFormat(locale === "ar" ? "ar-IQ-u-nu-latn" : "en-US", { style: "currency", currency: currency || "USD", maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency || "USD"}`;
  }
}

function formatDate(value: string, locale: Locale): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-IQ-u-nu-latn" : "en-GB", { dateStyle: "medium" }).format(date);
}
