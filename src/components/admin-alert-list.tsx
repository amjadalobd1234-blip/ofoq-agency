"use client";

import { useCallback, useEffect, useState } from "react";

import type { AdminAlertFilter, AdminAlertListResponse } from "@/lib/admin/alert-types";
import { normalizeAdminAlertList } from "@/lib/admin/payload";
import type { Locale } from "@/lib/domain/types";

const FILTERS: AdminAlertFilter[] = ["ALL", "OPEN", "NEW", "ACKNOWLEDGED", "RESOLVED"];

export function AdminAlertList({ locale }: { locale: Locale }) {
  const ar = locale === "ar";
  const [filter, setFilter] = useState<AdminAlertFilter>("ALL");
  const [data, setData] = useState<AdminAlertListResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/admin/alerts?status=${filter}&limit=100`, {
        cache: "no-store",
        signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Unable to load alerts.");
      setData(normalizeAdminAlertList(payload.data));
    } catch (reason) {
      if (!signal?.aborted) setError(reason instanceof Error ? reason.message : "Unable to load alerts.");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  return (
    <div className="dashboard-content admin-alert-list-page">
      <section className="platform-card admin-alert-list-toolbar">
        <div>
          <span className="eyebrow">{ar ? "مركز التنبيهات" : "ALERT CENTRE"}</span>
          <h2>{ar ? "كل التنبيهات" : "All alerts"}</h2>
          <p>{ar ? "افتح أي تنبيه للاطلاع على سياقه، والرد على العميل، وتسجيل المتابعة أو الحل." : "Open an alert to review its context, reply to the client, and record follow-up or resolution."}</p>
        </div>
        <button type="button" className="owner-admin-link" onClick={() => void load()} disabled={loading}>
          {loading ? (ar ? "جارٍ التحديث…" : "Refreshing…") : (ar ? "تحديث القائمة" : "Refresh list")}
        </button>
      </section>

      <section className="platform-card admin-alert-list-card" aria-label={ar ? "قائمة التنبيهات" : "Alert list"}>
        <div className="admin-filter-row" role="tablist" aria-label={ar ? "تصفية التنبيهات" : "Filter alerts"}>
          {FILTERS.map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={filter === item}
              className={filter === item ? "is-active" : ""}
              onClick={() => setFilter(item)}
            >
              {filterLabel(item, locale)}
            </button>
          ))}
        </div>

        {loading && !data ? <div className="loading-card admin-alert-loading"><span className="loading-orbit" />{ar ? "جارٍ تحميل التنبيهات…" : "Loading alerts…"}</div> : null}
        {error ? <div className="setup-notice platform-notice" role="alert"><span className="setup-notice-icon">!</span><div><strong>{ar ? "تعذر تحميل التنبيهات" : "Alerts could not be loaded"}</strong><p>{error}</p></div></div> : null}
        {!loading && !error && data?.items.length === 0 ? <div className="empty-state"><span className="empty-state-mark">◇</span><p>{ar ? "لا توجد تنبيهات ضمن هذه الحالة." : "There are no alerts in this state."}</p></div> : null}

        {data && data.items.length > 0 && (
          <>
            <p className="admin-alert-result-count">{data.total} {ar ? "تنبيه" : data.total === 1 ? "alert" : "alerts"}</p>
            <div className="admin-alert-list">
              {data.items.map((alert) => (
                <a className="admin-alert-list-item" href={`/admin/alerts/${encodeURIComponent(alert.id)}`} key={alert.id}>
                  <span className={`severity-dot severity-${alert.severity.toLowerCase()}`} aria-hidden="true" />
                  <div className="admin-alert-list-copy">
                    <div className="admin-alert-list-title-row">
                      <strong>{ar ? alert.titleAr : alert.titleEn}</strong>
                      <span className={`status-pill status-${alert.status.toLowerCase()}`}>{statusLabel(alert.status, locale)}</span>
                    </div>
                    {(ar ? alert.bodyAr : alert.bodyEn) && <p>{ar ? alert.bodyAr : alert.bodyEn}</p>}
                    <span>{[categoryLabel(alert.category, locale), alert.customerName || alert.customerEmail].filter(Boolean).join(" · ")}</span>
                  </div>
                  <time dateTime={alert.createdAt}>{formatDate(alert.createdAt, locale)}</time>
                  <span className="admin-alert-open-icon" aria-hidden="true">←</span>
                </a>
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function filterLabel(filter: AdminAlertFilter, locale: Locale): string {
  const labels: Record<AdminAlertFilter, [string, string]> = {
    OPEN: ["المفتوحة", "Open"],
    NEW: ["الجديدة", "New"],
    ACKNOWLEDGED: ["قيد المتابعة", "Acknowledged"],
    RESOLVED: ["المحلولة", "Resolved"],
    ALL: ["الكل", "All"],
  };
  return labels[filter][locale === "ar" ? 0 : 1];
}

function statusLabel(status: string, locale: Locale): string {
  const labels: Record<string, [string, string]> = {
    NEW: ["جديد", "New"],
    ACKNOWLEDGED: ["قيد المتابعة", "Acknowledged"],
    RESOLVED: ["تم الحل", "Resolved"],
  };
  return labels[status]?.[locale === "ar" ? 0 : 1] ?? status;
}

function categoryLabel(category: string, locale: Locale): string {
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
  return labels[category]?.[locale === "ar" ? 0 : 1] ?? category.replaceAll("_", " ");
}

function formatDate(value: string, locale: Locale): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-IQ-u-nu-latn" : "en-GB", { dateStyle: "medium" }).format(date);
}
