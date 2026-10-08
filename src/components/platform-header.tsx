import type { Locale } from "@/lib/domain/types";
import { Brand } from "@/components/brand-mark";
import { LocaleSwitch } from "@/components/locale-switch";
import { SignOutButton } from "@/components/sign-out-button";

export function PlatformHeader({ locale, staff = false, active }: {
  locale: Locale;
  staff?: boolean;
  active?: "dashboard" | "chat" | "admin";
}) {
  const ar = locale === "ar";
  return (
    <header className="platform-header">
      <Brand locale={locale} />
      <nav className="platform-nav" aria-label={ar ? "التنقل الرئيسي" : "Main navigation"}>
        <a className={active === "dashboard" ? "is-active" : ""} href="/dashboard">{ar ? "بوابة العميل" : "Client portal"}</a>
        <a className={active === "chat" ? "is-active" : ""} href="/chat">{ar ? "مساعد أفق" : "Ofoq assistant"}</a>
        {staff && <a className={active === "admin" ? "is-active" : ""} href="/admin">{ar ? "لوحة الإدارة" : "Admin"}</a>}
      </nav>
      <div className="platform-header-actions">
        <LocaleSwitch locale={locale} />
        <SignOutButton label={ar ? "خروج" : "Sign out"} />
      </div>
    </header>
  );
}
