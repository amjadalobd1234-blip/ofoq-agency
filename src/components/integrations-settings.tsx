"use client";

import { useCallback, useEffect, useState } from "react";

import { providerLabel } from "@/lib/ai/providers";
import type { Locale } from "@/lib/domain/types";

/**
 * Owner-only integrations screen (/admin/settings/integrations).
 *
 * Shows, for every AI provider: connection state (🟢 key present / 🔴 missing),
 * today's usage, and a "اختبار" button that sends one tiny real request to that
 * provider only. Below it, the last 10 AI requests recorded in `ai_usage`.
 *
 * The page never receives an API key: the API returns the NAME of the
 * environment variable each provider reads (set in Cloudflare Variables).
 */
interface ProviderRow {
  id: string;
  name: string;
  apiKeyEnv: string;
  configured: boolean;
  priority: number;
  models: string[];
  activeModel: string;
  dailyLimit: number;
  limitUnit: "day" | "month" | "minute";
  arabicFirst: boolean;
  noteAr: string;
  noteEn: string;
  usageToday: number;
  failuresToday: number;
  inputTokensToday: number;
  outputTokensToday: number;
}

interface RecentRow {
  id: string;
  provider: string;
  model: string;
  agentKey: string | null;
  customerId: string | null;
  inputTokens: number;
  outputTokens: number;
  status: string;
  durationMs: number;
  createdAt: string;
}

interface UsagePayload {
  generatedAt: string;
  usageAvailable: boolean;
  providers: ProviderRow[];
  recent: RecentRow[];
  email: { provider: "resend" | "console"; configured: boolean; from: string };
}

type TestResult = { ok: boolean; text: string; detail?: string };

export function IntegrationsSettings({ locale }: { locale: Locale }) {
  const ar = locale === "ar";
  const [data, setData] = useState<UsagePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [testingId, setTestingId] = useState("");
  const [results, setResults] = useState<Record<string, TestResult>>({});

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch("/api/admin/ai/usage", { cache: "no-store", signal });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || (ar ? "تعذر تحميل حالة المزودين." : "Provider status could not be loaded."));
      setData(payload.data as UsagePayload);
      setNotice(typeof payload.notice === "string" ? payload.notice : "");
      setError("");
    } catch (reason) {
      if (signal?.aborted) return;
      setError(reason instanceof Error ? reason.message : ar ? "تعذر تحميل البيانات." : "Unable to load the data.");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [ar]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function testProvider(providerId: string) {
    if (testingId) return;
    setTestingId(providerId);
    setResults((current) => ({ ...current, [providerId]: { ok: true, text: ar ? "جارٍ الاختبار…" : "Testing…" } }));
    try {
      const response = await fetch("/api/admin/ai/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setResults((current) => ({
          ...current,
          [providerId]: { ok: false, text: ar ? "فشل الاختبار" : "Test failed", detail: payload.error },
        }));
        return;
      }
      const result = payload.data ?? {};
      setResults((current) => ({
        ...current,
        [providerId]: result.ok
          ? {
              ok: true,
              text: ar ? `متصل · ${result.latencyMs ?? 0}ms` : `Connected · ${result.latencyMs ?? 0}ms`,
              detail: result.sample,
            }
          : {
              ok: false,
              text: statusLabel(String(result.status ?? "PROVIDER_ERROR"), locale),
              detail: result.error,
            },
      }));
      // Refresh counters so the tested call appears in "today" and "last 10".
      void load();
    } catch (reason) {
      setResults((current) => ({
        ...current,
        [providerId]: {
          ok: false,
          text: ar ? "تعذر تنفيذ الاختبار" : "The test could not run",
          detail: reason instanceof Error ? reason.message : undefined,
        },
      }));
    } finally {
      setTestingId("");
    }
  }

  if (loading) {
    return (
      <div className="platform-card loading-card" role="status">
        <span className="loading-orbit" />
        {ar ? "جارٍ تحميل حالة مزودي الذكاء الاصطناعي…" : "Loading AI provider status…"}
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="setup-notice platform-notice" role="alert">
        <span className="setup-notice-icon">!</span>
        <div>
          <strong>{ar ? "تعذر تحميل الإعدادات" : "Settings could not be loaded"}</strong>
          <p>{error}</p>
          <p>
            <button type="button" className="owner-admin-link" onClick={() => void load()}>
              {ar ? "إعادة المحاولة" : "Try again"}
            </button>
          </p>
        </div>
      </div>
    );
  }

  const configuredCount = data.providers.filter((provider) => provider.configured).length;

  return (
    <div className="dashboard-content integrations-settings">
      <section className="platform-card content-card">
        <div className="card-heading-row">
          <div>
            <span className="eyebrow">01 / {ar ? "مزودو الذكاء الاصطناعي" : "AI PROVIDERS"}</span>
            <h2>{ar ? "حالة المزودين والاستخدام اليوم" : "Provider status and today's usage"}</h2>
            <p className="integrations-lead">
              {ar
                ? "المفاتيح تُقرأ من متغيّرات المنصة فقط ولا تظهر في المتصفح. يجرّب المساعد المزودين بالترتيب: Groq ثم Gemini ثم NVIDIA ثم Cohere ثم OpenRouter."
                : "Keys are read from platform variables only and never reach the browser. The assistant tries providers in order: Groq, Gemini, NVIDIA, Cohere, OpenRouter."}
            </p>
          </div>
          <span className="mini-count">{configuredCount}</span>
        </div>

        <div className="provider-list">
          {data.providers.map((provider) => {
            const result = results[provider.id];
            const quota = `${provider.dailyLimit.toLocaleString("en-US")}/${unitLabel(provider.limitUnit, locale)}`;
            return (
              <article className="provider-row" key={provider.id}>
                <span className={`provider-dot ${provider.configured ? "provider-dot-on" : "provider-dot-off"}`} aria-hidden="true" />
                <div className="provider-row-main">
                  <strong>
                    {provider.name}
                    {provider.arabicFirst && <span className="provider-tag">{ar ? "الأفضل للعربية" : "Best Arabic"}</span>}
                  </strong>
                  <span>
                    <code>{provider.apiKeyEnv}</code> · {provider.configured ? (ar ? "متصل" : "Connected") : ar ? "غير متصل" : "Not connected"}
                    {" · "}
                    {ar ? "الموديل" : "Model"}: <code>{provider.activeModel}</code>
                  </span>
                  <span className="provider-note">{ar ? provider.noteAr : provider.noteEn}</span>
                </div>
                <div className="provider-row-side">
                  <span className="usage-counter">
                    {ar ? "الاستخدام اليوم" : "Today"} : <strong>{provider.usageToday}</strong>
                    {provider.failuresToday > 0 && <em> · {ar ? `${provider.failuresToday} فشل` : `${provider.failuresToday} failed`}</em>}
                  </span>
                  <span className="usage-quota">
                    {ar ? "الحد" : "Limit"}: {quota}
                    {" · "}
                    {provider.inputTokensToday + provider.outputTokensToday} {ar ? "توكن" : "tokens"}
                  </span>
                  <button
                    type="button"
                    className="provider-test-button"
                    onClick={() => void testProvider(provider.id)}
                    disabled={Boolean(testingId)}
                  >
                    {testingId === provider.id ? (ar ? "جارٍ الاختبار…" : "Testing…") : ar ? "اختبار" : "Test"}
                  </button>
                  {result && (
                    <span className={`provider-test-result ${result.ok ? "is-ok" : "is-fail"}`}>
                      {result.ok ? "✓" : "✗"} {result.text}
                      {result.detail && <small>{result.detail}</small>}
                    </span>
                  )}
                </div>
              </article>
            );
          })}
        </div>

        <p className="integrations-hint">
          <span>🔑</span>
          {ar
            ? "أضف المفاتيح في Cloudflare ← Settings ← Variables بأسماء: GROQ_API_KEY، GEMINI_API_KEY، NVIDIA_API_KEY، COHERE_API_KEY، OPENROUTER_API_KEY، RESEND_API_KEY. لا تحتاج إلى إعادة بناء الكود."
            : "Add the keys in Cloudflare → Settings → Variables using these names: GROQ_API_KEY, GEMINI_API_KEY, NVIDIA_API_KEY, COHERE_API_KEY, OPENROUTER_API_KEY, RESEND_API_KEY. No rebuild needed."}
        </p>

        <div className="integration-grid">
          <article className="platform-card integration-card">
            <div className="integration-card-head">
              <span className="integration-mark">✉</span>
              <span className="integration-status">
                {data.email.configured ? (ar ? "Resend مهيأ" : "Resend configured") : ar ? "بدون مفتاح Resend" : "No Resend key"}
              </span>
            </div>
            <h3>{ar ? "الإيميل (Resend)" : "Email (Resend)"}</h3>
            <p>
              {data.email.configured
                ? ar
                  ? `يُرسل من: ${data.email.from}`
                  : `Sending from: ${data.email.from}`
                : ar
                  ? "بدون RESEND_API_KEY تُجهَّز الرسائل وتُسجَّل في سجل الخادم بدل الإرسال."
                  : "Without RESEND_API_KEY, messages are rendered and written to the server log instead of being sent."}
            </p>
          </article>
        </div>
      </section>

      <section className="platform-card content-card">
        <div className="card-heading-row">
          <div>
            <span className="eyebrow">02 / {ar ? "آخر الطلبات" : "RECENT CALLS"}</span>
            <h2>{ar ? "آخر 10 طلبات ذكاء اصطناعي" : "The last 10 AI requests"}</h2>
          </div>
          <span className="mini-count">{data.recent.length}</span>
        </div>

        {notice && <p className="integrations-hint integrations-hint-warn"><span>!</span>{notice}</p>}

        {data.recent.length === 0 ? (
          <div className="empty-state">
            <span className="empty-state-mark">◇</span>
            <p>
              {data.usageAvailable
                ? ar
                  ? "لا توجد طلبات مسجّلة بعد."
                  : "No AI requests have been recorded yet."
                : ar
                  ? "جدول ai_usage غير مطبّق على قاعدة البيانات بعد، لذلك لا يمكن تسجيل الاستخدام."
                  : "The ai_usage table has not been applied to the database yet, so usage cannot be recorded."}
            </p>
          </div>
        ) : (
          <div className="usage-table" role="table" aria-label={ar ? "آخر طلبات الذكاء الاصطناعي" : "Recent AI requests"}>
            <div className="usage-row usage-row-head" role="row">
              <span role="columnheader">{ar ? "المزوّد" : "Provider"}</span>
              <span role="columnheader">{ar ? "الموديل" : "Model"}</span>
              <span role="columnheader">{ar ? "الحالة" : "Status"}</span>
              <span role="columnheader">{ar ? "توكن" : "Tokens"}</span>
              <span role="columnheader">{ar ? "المدة" : "Duration"}</span>
              <span role="columnheader">{ar ? "الوقت" : "Time"}</span>
            </div>
            {data.recent.map((row) => (
              <div className="usage-row" role="row" key={row.id}>
                <span role="cell">
                  {providerLabel(row.provider, locale)}
                  {row.agentKey && <small>{row.agentKey}</small>}
                </span>
                <span role="cell"><code>{row.model}</code></span>
                <span role="cell">
                  <span className={`status-pill usage-status usage-status-${row.status.toLowerCase()}`}>{statusLabel(row.status, locale)}</span>
                </span>
                <span role="cell">{Number(row.inputTokens) + Number(row.outputTokens)}</span>
                <span role="cell">{Number(row.durationMs)}ms</span>
                <span role="cell">{formatDateTime(row.createdAt, locale)}</span>
              </div>
            ))}
          </div>
        )}

        <p className="admin-generated-at">
          {ar ? "آخر تحديث" : "Updated"}: {formatDateTime(data.generatedAt, locale)}
        </p>
      </section>
    </div>
  );
}

function unitLabel(unit: "day" | "month" | "minute", locale: Locale): string {
  const ar = locale === "ar";
  if (unit === "minute") return ar ? "دقيقة" : "minute";
  if (unit === "month") return ar ? "شهر" : "month";
  return ar ? "يوم" : "day";
}

/** Status wording for the usage table (kept local: this is UI copy only). */
function statusLabel(status: string, locale: Locale): string {
  const ar = locale === "ar";
  const labels: Record<string, [string, string]> = {
    OK: ["ناجح", "OK"],
    RATE_LIMIT: ["تجاوز الحد", "Rate limited"],
    TIMEOUT: ["انتهت المهلة", "Timed out"],
    PROVIDER_ERROR: ["خطأ من المزوّد", "Provider error"],
    MISSING_KEY: ["مفتاح مفقود", "Missing key"],
    EMPTY_RESPONSE: ["رد فارغ", "Empty reply"],
    UNAVAILABLE: ["غير متاح", "Unavailable"],
  };
  return labels[status]?.[ar ? 0 : 1] ?? status.replaceAll("_", " ");
}

function formatDateTime(value: string, locale: Locale): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-IQ-u-nu-latn" : "en-GB", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
}
