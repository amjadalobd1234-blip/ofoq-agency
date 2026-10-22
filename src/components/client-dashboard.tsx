"use client";

import { useEffect, useState } from "react";

import type { Locale } from "@/lib/domain/types";
import { dictionaries } from "@/lib/i18n/dictionaries";

interface Project {
  id: string; code: string; title: string; titleEn?: string | null; brief?: string | null;
  status: string; progress: number; currency: string; amountTotalMinor: number | string;
  startDate?: string | null; dueDate?: string | null;
  tasks?: Array<{ id: string; title: string; titleEn?: string | null; status: string; dueDate?: string | null }>;
  /**
   * The approved plan, as the client dashboard RPC returns it.
   *
   * In production the portal reads Supabase directly, so this is where the
   * plan comes from — no DATABASE_URL and no local database involved.
   */
  plan?: ClientPlan | null;
}
/** The client-safe plan: phases and their client-visible tasks. */
interface ClientPlan {
  version: number;
  status: string;
  approvedAt?: string | null;
  summary?: string | null;
  phases: { key: string; title: string; dueDate?: string | null; tasks: { title: string; status: string; dueDate?: string | null }[] }[];
}
interface Offer {
  id: string; code: string; status: string; currency: string; totalMinor: number | string | null;
  validUntil?: string | null; clientNote?: string | null;
  items?: Array<{ descriptionAr: string; descriptionEn?: string | null; billingType: string; months?: number | null; unitPriceMinor?: number | string; totalMinor?: number | string }>;
}

/** Services a client can ask a formal offer for (catalogue slugs). */
const FORMAL_OFFER_SERVICES: Array<{ slug: string; ar: string; en: string }> = [
  { slug: "social-media-management", ar: "إدارة حسابات التواصل", en: "Social media management" },
  { slug: "content-design", ar: "كتابة وتصميم المنشورات", en: "Post writing and design" },
  { slug: "content-strategy", ar: "خطة المحتوى والنشر", en: "Content strategy and calendar" },
  { slug: "paid-ads", ar: "إدارة الإعلانات المدفوعة", en: "Paid ads management" },
  { slug: "branding", ar: "الهوية والمواد التسويقية", en: "Branding and marketing materials" },
  { slug: "web-development", ar: "إنشاء وتطوير المواقع", en: "Website development" },
  { slug: "seo", ar: "تحسين محركات البحث", en: "SEO" },
  { slug: "analytics-reports", ar: "تحليل الأداء والتقارير", en: "Analytics and reporting" },
  { slug: "consulting", ar: "استشارات وخطط تسويقية", en: "Consulting and marketing plans" },
];
interface Invoice {
  id: string; number: string; currency: string; totalMinor: number | string; amountPaidMinor: number | string;
  status: string; issuedAt?: string | null; dueAt?: string | null; notes?: string | null;
}
interface Campaign {
  id: string; name: string; platform: string; status: string; currency: string;
  totalBudgetMinor: number | string; spentMinor: number | string; syncStatus: string;
}
interface ClientAdPlan {
  id: string; code: string; version: number; status: string; summary: string | null;
  currency: string; approvedAt?: string | null;
  body: {
    objective: string; durationDays: number; dailyBudgetMinor: number; totalBudgetMinor: number;
    platforms: { platform: string; percent: number; dailyBudgetMinor: number; totalBudgetMinor: number; rationale: string }[];
    audience: { description: string; geo: string[] };
    adCopy: { platform: string; headline: string; primaryText: string; cta: string }[];
    adIdeas: { title: string; format: string; description: string }[];
    kpis: { key: string; labelAr: string; labelEn: string; target: string | null }[];
    analysis: { business: string; audience: string; platformRationale: string };
    disclaimerAr: string; disclaimerEn: string;
  };
  forecasts: { isEstimate: true; disclaimerAr: string; disclaimerEn: string; totals: { impressionsLow: number; impressionsHigh: number; clicksLow: number; clicksHigh: number; messagesLow: number; messagesHigh: number } } | null;
  actuals?: { spendMinor: number; impressions: number; clicks: number; messages: number; orders: number; ctr?: number | null; cpcMinor?: number | null };
  reports?: { id: string; title: string; summary: string; createdAt: string }[];
  disclaimerAr: string; disclaimerEn: string;
}
interface PortalData {
  customer: { id: string; name: string; companyName?: string | null; email?: string | null; locale: string } | null;
  projects: Project[]; offers: Offer[]; invoices: Invoice[];
  payments: Array<{ id: string; invoiceId?: string | null; amountMinor: number | string; refundedMinor: number | string; currency: string; method: string; status: string; paidAt?: string | null; createdAt: string }>;
  subscriptions: Array<{ id: string; planName: string; amountMinor: number | string; currency: string; status: string; periodEnd?: string | null; nextRenewalAt?: string | null }>,
  campaigns: Campaign[];
  /**
   * Approved ads plans from `ofoq_client_dashboard()` (migration 0012).
   * Production reads this over HTTPS — no DATABASE_URL required.
   */
  adPlans?: ClientAdPlan[];
  reports: Array<{ id: string; title: string; summary: string; type: string; createdAt: string }>;
  files: Array<{ id: string; name: string; kind?: string | null; sizeBytes: number | string; createdAt: string }>;
}

/** The client-safe project list served by GET /api/projects. */
interface ClientProject {
  id: string; code: string; title: string; titleEn?: string | null; status: string; progress: number;
  dueDate?: string | null; daysRemaining?: number | null;
  plan?: { version: number; status: string; approvedAt?: string | null } | null;
  tasks: { total: number; done: number; open: number };
}
/** The client-safe detail served by GET /api/projects/[id]. */
interface ClientProjectDetail {
  project: { id: string; code: string; title: string; status: string; progress: number; dueDate: string | null; daysRemaining?: number | null };
  plan: ClientPlan | null;
  tasks: { id: string; title: string; status: string; dueDate: string | null }[];
}

export function ClientDashboard({ locale }: { locale: Locale }) {
  const ar = locale === "ar";
  const copy = dictionaries[locale];
  const portal = copy.portal;
  const [data, setData] = useState<PortalData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [offerService, setOfferService] = useState(FORMAL_OFFER_SERVICES[0]!.slug);
  const [offerBusy, setOfferBusy] = useState<string | null>(null);
  const [offerNotice, setOfferNotice] = useState("");
  // The Projects Agent: the progress and the plan the client is allowed to see.
  const [trackedProjects, setTrackedProjects] = useState<ClientProject[] | null>(null);
  const [projectDetails, setProjectDetails] = useState<Record<string, ClientProjectDetail>>({});
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({});
  const [projectBusy, setProjectBusy] = useState<string | null>(null);
  const [adPlans, setAdPlans] = useState<ClientAdPlan[] | null>(null);
  const [expandedAdPlan, setExpandedAdPlan] = useState<string | null>(null);

  /** Loads the client-safe project list (progress + plan state). */
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/projects", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return;
        const payload = await response.json().catch(() => ({}));
        const rows = (payload.data?.rows ?? []) as ClientProject[];
        setTrackedProjects(rows);
      })
      .catch(() => {
        // The portal still shows the projects of the dashboard payload; the
        // Projects API is an addition, never a requirement to read the portal.
      })
      .finally(() => { if (!controller.signal.aborted) setProjectBusy(null); });
    return () => controller.abort();
  }, []);

  /**
   * Optional enrichment from GET /api/ads when DATABASE_URL is set.
   * Production without that variable still shows `data.adPlans` from the
   * dashboard RPC (0012). A 503 here must never blank the portal.
   */
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/ads", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return;
        const payload = await response.json().catch(() => ({}));
        setAdPlans((payload.data?.rows ?? []) as ClientAdPlan[]);
      })
      .catch(() => {
        // Keep the RPC payload. Staff APIs are an addition, not a requirement.
      });
    return () => controller.abort();
  }, []);

  /**
   * Shows (or hides) the plan of one project.
   *
   * The plan itself comes from the dashboard payload when the deployment
   * answers through Supabase (production) — the local Projects API is only
   * called when the payload carries no phase yet (local development).
   */
  function toggleProjectPlan(project: Project) {
    const expanded = expandedProjects[project.id] ?? Boolean(projectDetails[project.id]);
    if (expanded) {
      setExpandedProjects((current) => ({ ...current, [project.id]: false }));
      return;
    }
    setExpandedProjects((current) => ({ ...current, [project.id]: true }));
    if (projectDetails[project.id]) return;
    if ((project.plan?.phases?.length ?? 0) > 0) return;
    void openProjectPlan(project.id);
  }

  /** Opens the plan of one project: the phases and the tasks the client sees. */
  async function openProjectPlan(projectId: string) {
    if (projectDetails[projectId]) {
      setProjectDetails((current) => {
        const next = { ...current };
        delete next[projectId];
        return next;
      });
      return;
    }
    setProjectBusy(projectId);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Unable to load the project plan.");
      setProjectDetails((current) => ({ ...current, [projectId]: payload.data as ClientProjectDetail }));
    } catch (reason) {
      setOfferNotice(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setProjectBusy(null);
    }
  }

  /** Asks for a formal offer: creates a DRAFT for owner approval — never sent to the client as-is. */
  async function requestFormalOffer() {
    setOfferBusy("request");
    setOfferNotice("");
    try {
      const response = await fetch("/api/offers", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ services: [offerService] }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Request failed");
      setOfferNotice(ar
        ? `تم إنشاء مسودة العرض ${payload.data.code} وهي بانتظار مراجعة المالك وموافقته قبل إرسالها إليك.`
        : `Draft offer ${payload.data.code} was created and is waiting for owner review and approval before it is sent to you.`);
    } catch (reason) {
      setOfferNotice(reason instanceof Error ? reason.message : String(reason));
    } finally { setOfferBusy(null); }
  }

  /** The client's final decision on a SENT offer (accept / reject). */
  async function decideOffer(offer: Offer, decision: "accept" | "reject") {
    setOfferBusy(offer.id);
    setOfferNotice("");
    try {
      const response = await fetch(`/api/offers/${encodeURIComponent(offer.id)}/decision`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Decision failed");
      setData((current) => current ? {
        ...current,
        offers: current.offers.map((item) => item.id === offer.id ? { ...item, status: payload.data.status } : item),
      } : current);
      setOfferNotice(decision === "accept"
        ? (ar ? `تم قبول العرض ${offer.code}. تم إشعار المالك بقبولك، وإصدار الفاتورة قرار لاحق من المالك — لا فاتورة ولا دفع تلقائي الآن.` : `Offer ${offer.code} accepted. The owner has been notified; issuing any invoice is a separate owner decision — no invoice or payment now.`)
        : (ar ? `تم رفض العرض ${offer.code}.` : `Offer ${offer.code} rejected.`));
    } catch (reason) {
      setOfferNotice(reason instanceof Error ? reason.message : String(reason));
    } finally { setOfferBusy(null); }
  }

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/dashboard", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          // Full error surfaced in the console for debugging (status + body
          // from the server, which already excludes SQL/schema details).
          // eslint-disable-next-line no-console
          console.error("[ClientDashboard] /api/dashboard failed:", {
            status: response.status,
            statusText: response.statusText,
            payload,
          });
          throw new Error(payload.error || "Unable to load account data.");
        }
        setData(payload.data as PortalData);
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        // eslint-disable-next-line no-console
        console.error("[ClientDashboard] failed to load dashboard data:", reason);
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
  // RPC first (production). The Ads API, when it answers, may add reports/KPIs.
  const visibleAdPlans = ((adPlans && adPlans.length > 0 ? adPlans : data.adPlans) ?? []).filter(
    (plan) => plan.status === "APPROVED",
  );

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
              {data.projects.map((project) => {
                const tracked = trackedProjects?.find((entry) => entry.id === project.id) ?? null;
                const detail = projectDetails[project.id] ?? null;
                const plan = detail?.plan ?? project.plan ?? null;
                const expanded = expandedProjects[project.id] ?? Boolean(detail);
                const progress = Math.min(100, Math.max(0, Number(tracked?.progress ?? project.progress) || 0));
                return (
                <article className="project-row" key={project.id}>
                  <div className="project-row-main">
                    <div className="project-row-title"><div><h3>{ar ? project.title : project.titleEn || project.title}</h3><span className="project-code">{project.code}</span></div><StatusPill status={project.status} locale={locale} /></div>
                    <div className="progress-meta"><span>{portal.progress}</span><strong>{progress}%</strong></div>
                    <div className="progress-track"><span style={{ width: `${progress}%` }} /></div>
                    {project.dueDate && <p className="row-meta">{portal.dueDate}: {formatDate(project.dueDate, locale)}</p>}
                    {project.tasks && project.tasks.length > 0 && <p className="row-meta">{ar ? `المراحل الظاهرة لك: ${project.tasks.filter((task) => task.status === "DONE").length} من ${project.tasks.length}` : `Visible stages: ${project.tasks.filter((task) => task.status === "DONE").length} of ${project.tasks.length}`}</p>}
                    {plan && (
                      <p className="row-meta">
                        {ar ? "الخطة" : "Plan"}: v{plan.version} ·{" "}
                        {plan.status === "APPROVED"
                          ? (ar ? "معتمدة" : "approved")
                          : (ar ? "قيد المراجعة" : "under review")}
                      </p>
                    )}
                    <div className="offer-admin-actions">
                      <button type="button" disabled={projectBusy === project.id} onClick={() => toggleProjectPlan(project)}>
                        {expanded ? (ar ? "إخفاء الخطة" : "Hide the plan") : ar ? "عرض الخطة والمراحل" : "Show the plan and phases"}
                      </button>
                    </div>
                    {expanded && plan && plan.phases.length > 0 && (
                      <div className="client-plan">
                        {plan.summary && <p className="row-meta">{plan.summary}</p>}
                        {plan.phases.map((phase) => (
                          <div className="client-plan-phase" key={phase.key}>
                            <div className="client-plan-phase-head">
                              <strong>{phase.title}</strong>
                              {phase.dueDate && <span className="row-meta">{ar ? "حتى" : "by"} {formatDate(phase.dueDate, locale)}</span>}
                            </div>
                            <ul>
                              {phase.tasks.map((task, index) => (
                                <li key={`${phase.key}-${index}`}>
                                  <span>{task.title}</span>
                                  <StatusPill status={task.status} locale={locale} />
                                </li>
                              ))}
                            </ul>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </article>
                );
              })}
            </div>
          )}
        </section>

        <section className="platform-card content-card" aria-labelledby="offers-heading">
          <div className="card-heading-row"><div><span className="eyebrow">02 / {copy.dashboard.requests}</span><h2 id="offers-heading">{portal.offers}</h2></div><span className="mini-count">{data.offers.length}</span></div>
          <form className="offer-request-form" onSubmit={(event) => { event.preventDefault(); void requestFormalOffer(); }}>
            <label>
              <span>{ar ? "اطلب عرضًا رسميًا" : "Request a formal offer"}</span>
              <select value={offerService} onChange={(event) => setOfferService(event.target.value)}>
                {FORMAL_OFFER_SERVICES.map((service) => <option key={service.slug} value={service.slug}>{ar ? service.ar : service.en}</option>)}
              </select>
            </label>
            <button className="button button-gold" type="submit" disabled={offerBusy === "request"}>{ar ? "طلب عرض رسمي" : "Request formal offer"}</button>
          </form>
          {offerNotice && <p className="row-meta" role="status">{offerNotice}</p>}
          {data.offers.length === 0 ? <EmptyState text={portal.noOffers} /> : (
            <div className="compact-list">
              {data.offers.map((offer) => <article className="compact-row" key={offer.id}>
                <div className="compact-row-copy"><strong>{offer.code}</strong>
                  {(offer.items ?? []).map((item, index) => <span key={index}>{ar ? item.descriptionAr : item.descriptionEn || item.descriptionAr}{item.totalMinor !== undefined ? ` — ${formatMoney(item.totalMinor, offer.currency, locale)}` : ""}</span>)}
                  {offer.validUntil && <span>{ar ? "صالح حتى" : "Valid until"}: {formatDate(offer.validUntil, locale)}</span>}
                  {offer.clientNote && <span>{offer.clientNote}</span>}
                </div>
                <div className="compact-row-side"><strong>{offer.totalMinor === null ? (ar ? "يحتاج مراجعة" : "Needs review") : formatMoney(offer.totalMinor, offer.currency, locale)}</strong><StatusPill status={offer.status} locale={locale} />
                  {offer.status === "SENT" && <>
                    <button type="button" disabled={offerBusy === offer.id} onClick={() => void decideOffer(offer, "accept")}>{ar ? "قبول العرض" : "Accept offer"}</button>
                    <button type="button" disabled={offerBusy === offer.id} onClick={() => void decideOffer(offer, "reject")}>{ar ? "رفض العرض" : "Reject offer"}</button>
                  </>}
                </div>
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
          <div className="card-heading-row"><div><span className="eyebrow">04 / {copy.dashboard.reports}</span><h2 id="campaigns-heading">{ar ? "الخطة الإعلانية" : "Advertising plan"}</h2></div></div>
          {visibleAdPlans.length === 0 && data.campaigns.length === 0 ? <EmptyState text={ar ? "لا توجد خطة إعلانية معتمدة لحسابك بعد." : "No approved advertising plan is linked to your account yet."} /> : (
            <div className="compact-list">
              {visibleAdPlans.map((plan) => {
                const open = expandedAdPlan === plan.id;
                return (
                  <article className="compact-row" key={plan.id}>
                    <div className="compact-row-copy">
                      <strong>{plan.code}</strong>
                      <span>{plan.summary}</span>
                      <div className="offer-admin-actions">
                        <button type="button" onClick={() => setExpandedAdPlan(open ? null : plan.id)}>
                          {open ? (ar ? "إخفاء الخطة" : "Hide the plan") : ar ? "عرض الخطة المعتمدة" : "Show the approved plan"}
                        </button>
                      </div>
                      {open && (
                        <div className="client-plan">
                          <p className="row-meta">{plan.body?.analysis?.platformRationale}</p>
                          <ul>
                            {(plan.body?.platforms ?? []).map((row) => (
                              <li key={row.platform}>
                                <span>{row.platform.replaceAll("_", " ")} · {row.percent}%</span>
                                <span>{formatMoney(row.totalBudgetMinor, "USD", locale)}</span>
                              </li>
                            ))}
                          </ul>
                          <p className="row-meta">{ar ? "الجمهور" : "Audience"}: {plan.body?.audience?.description}</p>
                          {(plan.body?.adCopy ?? []).map((copyBlock) => (
                            <p className="row-meta" key={copyBlock.platform}><strong>{copyBlock.headline}</strong> — {copyBlock.primaryText}</p>
                          ))}
                          {plan.forecasts && (
                            <p className="row-meta">{ar ? plan.forecasts.disclaimerAr : plan.forecasts.disclaimerEn}</p>
                          )}
                          <p className="row-meta">
                            {ar ? "النتائج المُدخلة" : "Entered results"}: {formatMoney(plan.actuals?.spendMinor ?? 0, "USD", locale)} · {plan.actuals?.impressions ?? 0} {ar ? "ظهور" : "impr."} · {plan.actuals?.clicks ?? 0} {ar ? "نقرة" : "clicks"}
                          </p>
                          {(plan.reports ?? []).map((report) => (
                            <p className="row-meta" key={report.id}><strong>{report.title}</strong> — {report.summary}</p>
                          ))}
                          <p className="row-meta">{ar ? plan.disclaimerAr : plan.disclaimerEn}</p>
                        </div>
                      )}
                    </div>
                    <div className="compact-row-side">
                      <strong>{formatMoney(plan.body?.totalBudgetMinor ?? 0, "USD", locale)}</strong>
                      <StatusPill status="APPROVED" locale={locale} />
                    </div>
                  </article>
                );
              })}
              {data.campaigns.map((campaign) => <article className="compact-row" key={campaign.id}>
                <div className="compact-row-copy"><strong>{campaign.name}</strong><span>{campaign.platform.replaceAll("_", " ")} · {campaign.syncStatus === "DISABLED" || campaign.syncStatus === "NOT_CONNECTED" ? (ar ? "التكامل غير مربوط" : "Integration not connected") : campaign.syncStatus}</span></div>
                <div className="compact-row-side"><strong>{formatMoney(campaign.spentMinor, campaign.currency, locale)}</strong><StatusPill status={campaign.status} locale={locale} /></div>
              </article>)}
            </div>
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
