"use client";

import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";

import { PlatformFrame } from "@/components/platform-frame";
import { canOpenAdmin, roleLabel } from "@/lib/auth/admin-access";
import { useCurrentUser, type CurrentUser } from "@/lib/auth/use-current-user";
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

export interface AdminAccessGateProps {
  title: { ar: string; en: string };
  description: { ar: string; en: string };
  /** Keeps the integrations shortcut on the control-room landing page only. */
  showIntegrationsShortcut?: boolean;
  children: (context: { locale: Locale; user: CurrentUser }) => ReactNode;
}

/**
 * Shared client-side guard and shell for every /admin surface.
 *
 * The browser gate keeps the admin chrome from flashing for a client account;
 * each API route and every RPC still enforce staff access independently.
 */
export function AdminAccessGate({
  title,
  description,
  showIntegrationsShortcut = false,
  children,
}: AdminAccessGateProps) {
  const router = useRouter();
  const session = useCurrentUser();
  const [locale, setLocale] = useState<Locale>("ar");

  useEffect(() => {
    setLocale(readLocaleCookie());
  }, []);

  useEffect(() => {
    if (session.phase === "anonymous") {
      router.replace(`/login?next=${encodeURIComponent(window.location.pathname)}`);
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
        title={title[locale]}
        description={description[locale]}
      >
        {showIntegrationsShortcut && user.role === "OWNER" && (
          <p className="admin-settings-link">
            <a className="owner-admin-link" href="/admin/settings/integrations">
              {ar ? "⚙ إعدادات التكاملات (الذكاء الاصطناعي والإيميل)" : "⚙ Integration settings (AI and email)"}
            </a>
          </p>
        )}
        {children({ locale, user })}
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
