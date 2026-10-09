"use client";

import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";

import { AdminDashboard } from "@/components/admin-dashboard";
import { PlatformFrame } from "@/components/platform-frame";
import { canOpenAdmin, roleLabel } from "@/lib/auth/admin-access";
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
 * /admin — owner and partner control room.
 *
 * 1. Checks the session via /api/me (no session → /login).
 * 2. Checks the role: only OWNER or PARTNER stay here; everyone else → /dashboard.
 * 3. Renders the dashboard. Its data comes from the `ofoq_admin_dashboard` RPC,
 *    which re-checks staff status in the database.
 *
 * Until the role is confirmed, only a neutral loading card is rendered, so the
 * admin shell (navigation, data) never flashes for a client.
 */
export default function AdminPage() {
  const router = useRouter();
  const session = useCurrentUser();
  const [locale, setLocale] = useState<Locale>("ar");

  useEffect(() => {
    setLocale(readLocaleCookie());
  }, []);

  useEffect(() => {
    if (session.phase === "anonymous") {
      router.replace("/login?next=%2Fadmin");
    } else if (session.phase === "ready" && !canOpenAdmin(session.user.role)) {
      router.replace("/dashboard");
    }
  }, [session, router]);

  const ar = locale === "ar";

  if (session.phase === "ready" && canOpenAdmin(session.user.role)) {
    const user = session.user;
    return (
      <PlatformFrame
        locale={locale}
        staff
        active="admin"
        identity={{ name: user.name, role: roleLabel(user.role, locale) }}
        title={ar ? "لوحة المالك والشريك" : "Owner and partner dashboard"}
        description={ar ? "مركز المراقبة يعرض بيانات تشغيل فعلية دون اختلاق عملاء أو نتائج." : "The control room shows real operational data without fabricated clients or results."}
      >
        <AdminDashboard locale={locale} />
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
              <button type="button" className="owner-admin-link" onClick={() => window.location.reload()}>{ar ? "إعادة المحاولة" : "Try again"}</button>{" "}
              <a className="owner-admin-link" href="/dashboard">{ar ? "بوابة العميل" : "Client portal"}</a>
            </p>
          </div>
        </div>
      </GuardShell>
    );
  }

  // loading · anonymous (redirecting to /login) · non-staff (redirecting to /dashboard)
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
