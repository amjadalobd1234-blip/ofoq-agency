"use client";

import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";

import { IntegrationsSettings } from "@/components/integrations-settings";
import { PlatformFrame } from "@/components/platform-frame";
import { roleLabel } from "@/lib/auth/admin-access";
import { useCurrentUser } from "@/lib/auth/use-current-user";
import type { Locale } from "@/lib/domain/types";
import { isLocale } from "@/lib/i18n/dictionaries";

// Same cookie name as LOCALE_COOKIE in lib/i18n. That module imports next/headers,
// so a client component cannot import it.
const LOCALE_COOKIE = "ofoq_locale";

function readLocaleCookie(): Locale {
  if (typeof document === "undefined") return "ar";
  const value = document.cookie.match(/(?:^|;\s*)ofoq_locale=([^;]+)/)?.[1];
  return isLocale(value) ? value : "ar";
}

/**
 * /admin/settings/integrations — OWNER only.
 *
 * 1. Checks the session via /api/me (no session → /login).
 * 2. Checks the role: OWNER stays, everyone else → /admin or /dashboard.
 * 3. Renders provider status, today's usage and the last 10 AI requests.
 *
 * The data comes from `/api/admin/ai/usage`, which re-checks the owner role and
 * reads usage through the `ofoq_ai_usage_admin` RPC (owner-only in SQL). No API
 * key ever reaches this page — only the NAME of each environment variable.
 */
export default function IntegrationsPage() {
  const router = useRouter();
  const session = useCurrentUser();
  const [locale, setLocale] = useState<Locale>("ar");

  useEffect(() => {
    setLocale(readLocaleCookie());
  }, []);

  useEffect(() => {
    if (session.phase === "anonymous") {
      router.replace("/login?next=%2Fadmin%2Fsettings%2Fintegrations");
    } else if (session.phase === "ready" && session.user.role !== "OWNER") {
      // Partners keep the control room; only the owner manages platform keys.
      router.replace(session.user.role === "PARTNER" ? "/admin" : "/dashboard");
    }
  }, [session, router]);

  const ar = locale === "ar";

  if (session.phase === "ready" && session.user.role === "OWNER") {
    const user = session.user;
    return (
      <PlatformFrame
        locale={locale}
        staff
        active="admin"
        identity={{ name: user.name, role: roleLabel(user.role, locale) }}
        title={ar ? "إعدادات التكاملات" : "Integration settings"}
        description={
          ar
            ? "حالة مزودي الذكاء الاصطناعي والإيميل، والاستخدام اليومي، وآخر الطلبات. هذه الصفحة للمالك فقط."
            : "AI and email provider status, daily usage and recent requests. This page is owner-only."
        }
      >
        <IntegrationsSettings locale={locale} />
        <p className="integrations-back-link">
          <a className="owner-admin-link" href="/admin">
            {ar ? "↩ العودة إلى لوحة المراقبة" : "↩ Back to the control room"}
          </a>
        </p>
      </PlatformFrame>
    );
  }

  if (session.phase === "error") {
    return (
      <GuardShell>
        <div className="setup-notice platform-notice" role="alert">
          <span className="setup-notice-icon">!</span>
          <div>
            <strong>{ar ? "تعذر التحقق من حسابك" : "Your account could not be verified"}</strong>
            <p>{session.message}</p>
            <p>
              <button type="button" className="owner-admin-link" onClick={() => window.location.reload()}>
                {ar ? "إعادة المحاولة" : "Try again"}
              </button>{" "}
              <a className="owner-admin-link" href="/admin">
                {ar ? "لوحة المراقبة" : "Control room"}
              </a>
            </p>
          </div>
        </div>
      </GuardShell>
    );
  }

  // loading · anonymous (redirecting to /login) · non-owner (redirecting away)
  return (
    <GuardShell>
      <div className="platform-card loading-card" role="status">
        <span className="loading-orbit" />
        {ar ? "جارٍ التحقق من صلاحياتك…" : "Checking your access…"}
      </div>
    </GuardShell>
  );
}

function GuardShell({ children }: { children: ReactNode }) {
  return (
    <main className="platform-shell">
      <div className="platform-main">{children}</div>
    </main>
  );
}
