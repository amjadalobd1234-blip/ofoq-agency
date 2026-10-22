"use client";

import { useCallback, useEffect, useState } from "react";

import type { Locale } from "@/lib/domain/types";

/**
 * The Ads panel of the admin dashboard (وكيل الإعلانات).
 *
 * Everything here goes through the real Ads API. The UI never decides an
 * authorisation and never talks to Meta / Google / TikTok.
 */

interface AdPlanRow {
  id: string;
  code: string;
  customerId: string;
  customerName: string | null;
  customerCompany: string | null;
  projectId: string | null;
  version: number;
  status: string;
  summary: string | null;
  internalNote: string | null;
  approvedAt: string | null;
  approvedVersion: number | null;
  requiresOwnerApproval: boolean;
  body: {
    objective: string;
    businessCategory: string;
    durationDays: number;
    dailyBudgetMinor: number;
    totalBudgetMinor: number;
    platforms: { platform: string; percent: number; dailyBudgetMinor: number; totalBudgetMinor: number }[];
    audience: { description: string; geo: string[] };
    adCopy: { platform: string; headline: string; primaryText: string; cta: string }[];
    adIdeas: { title: string; format: string; description: string }[];
    kpis: { key: string; labelAr: string; target: string | null }[];
    analysis: { business: string; audience: string; platformRationale: string };
    disclaimerAr: string;
  } | null;
  forecasts: {
    isEstimate: true;
    disclaimerAr: string;
    totals: { impressionsLow: number; impressionsHigh: number; clicksLow: number; clicksHigh: number };
  } | null;
}

interface ClientOption {
  id: string;
  name: string;
  companyName: string | null;
}

const CATEGORIES: { id: string; ar: string; en: string }[] = [
  { id: "LOCAL_RETAIL", ar: "تجزئة محلية", en: "Local retail" },
  { id: "RESTAURANT", ar: "مطعم / كافيه", en: "Restaurant / cafe" },
  { id: "SERVICES", ar: "خدمات محلية", en: "Local services" },
  { id: "PROFESSIONAL", ar: "خدمات مهنية", en: "Professional services" },
  { id: "ECOMMERCE", ar: "متجر إلكتروني", en: "E-commerce" },
  { id: "CONTENT", ar: "محتوى / ترفيه", en: "Content / entertainment" },
  { id: "REAL_ESTATE", ar: "عقارات", en: "Real estate" },
  { id: "EDUCATION", ar: "تعليم", en: "Education" },
  { id: "HEALTH", ar: "صحة", en: "Health" },
  { id: "OTHER", ar: "أخرى", en: "Other" },
];

const OBJECTIVES: { id: string; ar: string; en: string }[] = [
  { id: "AWARENESS", ar: "وعي بالعلامة", en: "Awareness" },
  { id: "TRAFFIC", ar: "زيارات", en: "Traffic" },
  { id: "ENGAGEMENT", ar: "تفاعل", en: "Engagement" },
  { id: "MESSAGES", ar: "رسائل واتساب", en: "Messages" },
  { id: "LEADS", ar: "عملاء محتملون", en: "Leads" },
  { id: "SALES", ar: "مبيعات", en: "Sales" },
];

export function AdminAds({ locale, clients }: { locale: Locale; clients: ClientOption[] }) {
  const ar = locale === "ar";
  const [plans, setPlans] = useState<AdPlanRow[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const [customerId, setCustomerId] = useState("");
  const [category, setCategory] = useState("OTHER");
  const [objective, setObjective] = useState("MESSAGES");
  const [brief, setBrief] = useState("");
  const [audience, setAudience] = useState("");
  const [budget, setBudget] = useState("300");
  const [days, setDays] = useState("30");
  const [internalNote, setInternalNote] = useState("");

  const [resultDate, setResultDate] = useState("");
  const [resultSpend, setResultSpend] = useState("");
  const [resultImpressions, setResultImpressions] = useState("");
  const [resultClicks, setResultClicks] = useState("");
  const [resultMessages, setResultMessages] = useState("");
  const [resultOrders, setResultOrders] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/ads", { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Unable to load the ads plans.");
      setPlans((payload.data?.rows ?? []) as AdPlanRow[]);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function callApi(url: string, init: RequestInit, key: string): Promise<boolean> {
    setBusy(key);
    setNotice("");
    try {
      const response = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init.headers ?? {}) } });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Request failed");
      await load();
      return true;
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : String(reason));
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function createPlan() {
    if (!customerId) {
      setNotice(ar ? "اختر عميلًا." : "Pick a customer.");
      return;
    }
    const totalBudgetUsd = Number(budget);
    const durationDays = Number(days);
    const ok = await callApi(
      "/api/ads",
      {
        method: "POST",
        body: JSON.stringify({
          customerId,
          businessCategory: category,
          objective,
          brief: brief.trim() || null,
          audience: audience.trim() || null,
          totalBudgetUsd,
          durationDays,
          internalNote: internalNote.trim() || null,
          locale,
        }),
      },
      "create",
    );
    if (ok) {
      setBrief("");
      setAudience("");
      setInternalNote("");
      setNotice(ar ? "حُفظت الخطة كمسودة. يلزم اعتماد المالك قبل أن يراها العميل. لا إطلاق ولا إنفاق." : "The plan was saved as a draft. The owner's approval is required before the client sees it. Nothing is launched or spent.");
    }
  }

  async function submitPlan(plan: AdPlanRow) {
    const ok = await callApi(`/api/ads/${encodeURIComponent(plan.id)}/submit`, { method: "POST", body: "{}" }, `submit-${plan.id}`);
    if (ok) setNotice(ar ? "أُرسلت الخطة لمراجعة المالك داخل التطبيق." : "The plan was sent to the owner inside the app.");
  }

  async function approvePlan(plan: AdPlanRow) {
    const ok = await callApi(`/api/ads/${encodeURIComponent(plan.id)}/approve`, { method: "POST", body: "{}" }, `approve-${plan.id}`);
    if (ok) setNotice(ar ? "اعتُمدت الخطة. العميل يراها الآن. لم يُطلق أي إعلان." : "The plan is approved. The client can see it. No ad was launched.");
  }

  async function recordResults(plan: AdPlanRow) {
    const ok = await callApi(
      `/api/ads/${encodeURIComponent(plan.id)}/results`,
      {
        method: "POST",
        body: JSON.stringify({
          date: resultDate || new Date().toISOString().slice(0, 10),
          spendUsd: Number(resultSpend || 0),
          impressions: Number(resultImpressions || 0),
          clicks: Number(resultClicks || 0),
          messages: Number(resultMessages || 0),
          orders: Number(resultOrders || 0),
        }),
      },
      `results-${plan.id}`,
    );
    if (ok) {
      setResultSpend("");
      setResultImpressions("");
      setResultClicks("");
      setResultMessages("");
      setResultOrders("");
      setNotice(ar ? "سُجّلت النتائج يدويًا. لم يُجلب شيء من منصات الإعلان." : "Results were recorded manually. Nothing was fetched from an ads platform.");
    }
  }

  async function analyzePlan(plan: AdPlanRow) {
    const ok = await callApi(`/api/ads/${encodeURIComponent(plan.id)}/analyze`, { method: "POST", body: "{}" }, `analyze-${plan.id}`);
    if (ok) setNotice(ar ? "حُفظ تقرير المسودة. الخطة المعتمدة لم تتغير." : "A draft report was saved. The approved plan was not changed.");
  }

  if (error) return <div className="empty-state"><p>{error}</p></div>;
  if (!plans) return <p className="row-meta">{ar ? "جارٍ تحميل الخطط الإعلانية…" : "Loading ads plans…"}</p>;

  return (
    <div className="admin-projects-panel">
      <p className="card-subtitle">
        {ar
          ? "الوكيل استشاري فقط. لا اتصال بـ Meta أو Google أو TikTok، ولا إطلاق ولا إنفاق من المنصة."
          : "The agent is advisory only. No Meta, Google or TikTok connection, and the platform never launches or spends."}
      </p>
      <form
        className="offer-request-form"
        onSubmit={(event) => {
          event.preventDefault();
          void createPlan();
        }}
      >
        <label>
          <span>{ar ? "العميل" : "Customer"}</span>
          <select value={customerId} onChange={(event) => setCustomerId(event.target.value)}>
            <option value="">{ar ? "اختر عميلًا" : "Pick a customer"}</option>
            {clients.map((client) => (
              <option key={client.id} value={client.id}>
                {client.companyName ? `${client.companyName} — ${client.name}` : client.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{ar ? "النشاط" : "Business"}</span>
          <select value={category} onChange={(event) => setCategory(event.target.value)}>
            {CATEGORIES.map((item) => (
              <option key={item.id} value={item.id}>{ar ? item.ar : item.en}</option>
            ))}
          </select>
        </label>
        <label>
          <span>{ar ? "هدف الحملة" : "Objective"}</span>
          <select value={objective} onChange={(event) => setObjective(event.target.value)}>
            {OBJECTIVES.map((item) => (
              <option key={item.id} value={item.id}>{ar ? item.ar : item.en}</option>
            ))}
          </select>
        </label>
        <label>
          <span>{ar ? "الميزانية الإجمالية USD" : "Total budget USD"}</span>
          <input type="number" min="1" step="1" value={budget} onChange={(event) => setBudget(event.target.value)} />
        </label>
        <label>
          <span>{ar ? "المدة (يوم)" : "Duration (days)"}</span>
          <input type="number" min="1" max="365" value={days} onChange={(event) => setDays(event.target.value)} />
        </label>
        <label>
          <span>{ar ? "موجز النشاط والأهداف" : "Brief and goals"}</span>
          <input type="text" value={brief} maxLength={400} onChange={(event) => setBrief(event.target.value)} />
        </label>
        <label>
          <span>{ar ? "الجمهور" : "Audience"}</span>
          <input type="text" value={audience} maxLength={300} onChange={(event) => setAudience(event.target.value)} />
        </label>
        <label>
          <span>{ar ? "ملاحظة داخلية" : "Internal note"}</span>
          <input type="text" value={internalNote} maxLength={400} onChange={(event) => setInternalNote(event.target.value)} />
        </label>
        <button className="button button-gold" type="submit" disabled={busy === "create"}>
          {ar ? "إعداد خطة إعلانية" : "Prepare an ads plan"}
        </button>
      </form>
      {notice && <p className="row-meta" role="status">{notice}</p>}

      {plans.length === 0 ? (
        <div className="empty-state"><span className="empty-state-mark">◇</span><p>{ar ? "لا توجد خطط إعلانية بعد." : "No ads plans yet."}</p></div>
      ) : (
        <div className="compact-list">
          {plans.map((plan) => {
            const open = openId === plan.id;
            return (
              <article className="compact-row" key={plan.id}>
                <div className="compact-row-copy">
                  <strong>{plan.code} · {plan.customerCompany || plan.customerName}</strong>
                  <span>{plan.summary}</span>
                  <span className="row-meta">
                    v{plan.version} · {plan.status}
                    {plan.approvedVersion ? ` · ${ar ? "المعتمدة" : "approved"} v${plan.approvedVersion}` : ""}
                  </span>
                  <div className="offer-admin-actions">
                    <button type="button" onClick={() => setOpenId(open ? null : plan.id)}>
                      {open ? (ar ? "إخفاء" : "Hide") : ar ? "عرض التفاصيل" : "Show details"}
                    </button>
                    {plan.status !== "APPROVED" && (
                      <button type="button" disabled={busy === `submit-${plan.id}`} onClick={() => void submitPlan(plan)}>
                        {ar ? "إرسال للمالك" : "Send to owner"}
                      </button>
                    )}
                    {plan.status !== "APPROVED" && (
                      <button type="button" disabled={busy === `approve-${plan.id}`} onClick={() => void approvePlan(plan)}>
                        {ar ? "اعتماد الخطة" : "Approve the plan"}
                      </button>
                    )}
                    {plan.status === "APPROVED" && (
                      <button type="button" disabled={busy === `analyze-${plan.id}`} onClick={() => void analyzePlan(plan)}>
                        {ar ? "تحليل النتائج" : "Analyse results"}
                      </button>
                    )}
                  </div>
                  {open && plan.body && (
                    <div className="client-plan">
                      <p className="row-meta">{plan.body.analysis.platformRationale}</p>
                      <ul>
                        {plan.body.platforms.map((row) => (
                          <li key={row.platform}>
                            <span>{row.platform.replaceAll("_", " ")} · {row.percent}%</span>
                            <span>{formatUsd(row.totalBudgetMinor, locale)} / {formatUsd(row.dailyBudgetMinor, locale)} {ar ? "يومي" : "daily"}</span>
                          </li>
                        ))}
                      </ul>
                      <p className="row-meta">{plan.body.audience.description} · {plan.body.audience.geo.join("، ")}</p>
                      {plan.body.adCopy.map((copy) => (
                        <p className="row-meta" key={copy.platform}>
                          <strong>{copy.headline}</strong> — {copy.primaryText} ({copy.cta})
                        </p>
                      ))}
                      {plan.forecasts && (
                        <p className="row-meta">
                          {ar ? "تقدير الظهور" : "Estimated impressions"}: {plan.forecasts.totals.impressionsLow}–{plan.forecasts.totals.impressionsHigh}. {plan.forecasts.disclaimerAr}
                        </p>
                      )}
                      {plan.internalNote && <p className="row-meta">{ar ? "داخلي" : "Internal"}: {plan.internalNote}</p>}
                      {plan.status === "APPROVED" && (
                        <form
                          className="offer-request-form"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void recordResults(plan);
                          }}
                        >
                          <label>
                            <span>{ar ? "التاريخ" : "Date"}</span>
                            <input type="date" value={resultDate} onChange={(event) => setResultDate(event.target.value)} />
                          </label>
                          <label>
                            <span>{ar ? "إنفاق USD" : "Spend USD"}</span>
                            <input type="number" min="0" step="0.01" value={resultSpend} onChange={(event) => setResultSpend(event.target.value)} />
                          </label>
                          <label>
                            <span>{ar ? "ظهور" : "Impressions"}</span>
                            <input type="number" min="0" value={resultImpressions} onChange={(event) => setResultImpressions(event.target.value)} />
                          </label>
                          <label>
                            <span>{ar ? "نقرات" : "Clicks"}</span>
                            <input type="number" min="0" value={resultClicks} onChange={(event) => setResultClicks(event.target.value)} />
                          </label>
                          <label>
                            <span>{ar ? "رسائل" : "Messages"}</span>
                            <input type="number" min="0" value={resultMessages} onChange={(event) => setResultMessages(event.target.value)} />
                          </label>
                          <label>
                            <span>{ar ? "طلبات" : "Orders"}</span>
                            <input type="number" min="0" value={resultOrders} onChange={(event) => setResultOrders(event.target.value)} />
                          </label>
                          <button type="submit" disabled={busy === `results-${plan.id}`}>
                            {ar ? "حفظ النتائج اليدوية" : "Save manual results"}
                          </button>
                        </form>
                      )}
                    </div>
                  )}
                </div>
                <div className="compact-row-side">
                  <strong>{plan.body ? formatUsd(plan.body.totalBudgetMinor, locale) : "—"}</strong>
                  <span className={`status-pill status-${plan.status.toLowerCase()}`}>
                    {plan.status === "APPROVED" ? (ar ? "معتمدة" : "Approved") : plan.status === "AWAITING_APPROVAL" ? (ar ? "بانتظار المالك" : "Awaiting owner") : ar ? "مسودة" : "Draft"}
                  </span>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

function formatUsd(minor: number, locale: Locale): string {
  const amount = Number(minor || 0) / 100;
  try {
    return new Intl.NumberFormat(locale === "ar" ? "ar-IQ-u-nu-latn" : "en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} USD`;
  }
}
