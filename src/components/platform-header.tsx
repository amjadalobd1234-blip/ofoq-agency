import type { Locale } from "@/lib/domain/types";
import { Brand } from "@/components/brand-mark";
import { LocaleSwitch } from "@/components/locale-switch";
import { SignOutButton } from "@/components/sign-out-button";

export interface HeaderIdentity {
  name: string;
  /** Already-translated role label, e.g. "المالك" / "Owner". */
  role: string;
}

export function PlatformHeader({ locale, staff = false, active, identity }: {
  locale: Locale;
  staff?: boolean;
  active?: "dashboard" | "chat" | "admin";
  identity?: HeaderIdentity;
}) {
  const ar = locale === "ar";
  return (
    <header className="platform-header">
      <Brand locale={locale} />
      <nav className="platform-nav" aria-label={ar ? "التنقل الرئيسي" : "Main navigation"}>
        {/* With an identity (admin view) the portal link is rendered as a button in the actions bar. */}
        {!identity && <a className={active === "dashboard" ? "is-active" : ""} href="/dashboard">{ar ? "بوابة العميل" : "Client portal"}</a>}
        <a className={active === "chat" ? "is-active" : ""} href="/chat">{ar ? "مساعد أفق" : "Ofoq assistant"}</a>
        {staff && <a className={active === "admin" ? "is-active" : ""} href="/admin">{ar ? "لوحة الإدارة" : "Admin"}</a>}
      </nav>
      <div className="platform-header-actions">
        {identity && (
          <span className="header-identity" aria-label={ar ? "الحساب الحالي" : "Signed-in account"}>
            <strong>{identity.name}</strong>
            <span className="role-chip">{identity.role}</span>
          </span>
        )}
        {identity && <a className="portal-button" href="/dashboard">{ar ? "بوابة العميل" : "Client portal"}</a>}
        <LocaleSwitch locale={locale} />
        <SignOutButton label={ar ? "خروج" : "Sign out"} />
      </div>
    </header>
  );
}
