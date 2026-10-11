"use client";

import { useEffect, useState } from "react";

import type { Locale } from "@/lib/domain/types";
import { isLocale } from "@/lib/i18n/dictionaries";

/**
 * Error boundary for every surface under `/admin`
 * (`/admin`, `/admin/alerts`, `/admin/alerts/[id]`, `/admin/settings/...`).
 *
 * Why it exists
 * -------------
 * Without this file, any uncaught render error inside the admin tree unmounted
 * the whole page and Next.js served its generic production document:
 *
 *     "Application error: a client-side exception has occurred"
 *
 * That message names neither the component, nor the payload field, nor the
 * cause - which is exactly why the /admin crash was hard to diagnose. This
 * boundary renders the real `error.message` plus the production `digest`, so
 * the cause is visible in the browser and in a screenshot.
 *
 * Next.js resets the boundary on navigation, so a failure in one admin screen
 * no longer takes the whole section down with it.
 */

// Same cookie name as LOCALE_COOKIE in lib/i18n. That module imports
// next/headers, so a client component cannot import it.
const LOCALE_COOKIE = "ofoq_locale";

function readLocaleCookie(): Locale {
  if (typeof document === "undefined") return "ar";
  const value = document.cookie.match(/(?:^|;\s*)ofoq_locale=([^;]+)/)?.[1];
  return isLocale(value) ? value : "ar";
}

export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [locale, setLocale] = useState<Locale>("ar");
  const ar = locale === "ar";

  useEffect(() => {
    setLocale(readLocaleCookie());
  }, []);

  // A production error boundary is otherwise the one place a stack trace is
  // guaranteed NOT to reach the browser console.
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error("[admin] uncaught render error:", error);
  }, [error]);

  const name = error.name || "Error";
  const message = error.message || (ar ? "حدث خطأ غير متوقع." : "An unexpected error occurred.");

  return (
    <main className="platform-shell">
      <div className="platform-main">
        <div className="platform-page-heading">
          <span className="eyebrow">{ar ? "منصة أفق" : "OFOQ PLATFORM"}</span>
          <h1>{ar ? "تعذر عرض لوحة الإدارة" : "The admin panel could not be displayed"}</h1>
          <p>
            {ar
              ? "هذا خطأ في عرض اللوحة وليس في صلاحياتك. التفاصيل بالأسفل تحدد السبب."
              : "This is a rendering fault in the panel, not a permissions problem. The details below identify the cause."}
          </p>
        </div>

        <section className="platform-card admin-error-card" role="alert">
          <div className="setup-notice platform-notice">
            <span className="setup-notice-icon">!</span>
            <div>
              <strong>{name}</strong>
              <p>{message}</p>
            </div>
          </div>

          {error.digest ? (
            <p className="admin-error-digest">
              {ar ? "معرّف الخطأ" : "Error digest"}: <code>{error.digest}</code>
            </p>
          ) : null}

          <p className="admin-error-hint">
            {ar
              ? "انسخ نص الخطأ أعلاه مع اسم المكوّن وأرسله للمطوّر. إذا كان الحقل ناقصًا في الاستجابة، أعد تطبيق ترحيلات قاعدة البيانات (docs/setup/supabase-setup.sql)."
              : "Copy the error text above together with the component name and send it to the developer. If a payload field is missing, re-apply the database migrations (docs/setup/supabase-setup.sql)."}
          </p>

          <div className="admin-error-actions">
            <button type="button" className="admin-action-button" onClick={reset}>
              {ar ? "إعادة المحاولة" : "Try again"}
            </button>
            <a className="owner-admin-link" href="/admin">
              {ar ? "العودة إلى لوحة الإدارة" : "Back to the dashboard"}
            </a>
            <a className="owner-admin-link" href="/dashboard">
              {ar ? "بوابة العميل" : "Client portal"}
            </a>
          </div>
        </section>
      </div>
    </main>
  );
}