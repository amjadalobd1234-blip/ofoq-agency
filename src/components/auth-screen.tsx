import type { ReactNode } from "react";

import type { Locale } from "@/lib/domain/types";
import { Brand } from "@/components/brand-mark";
import { LocaleSwitch } from "@/components/locale-switch";

export function AuthScreen({ locale, children }: { locale: Locale; children: ReactNode }) {
  const isArabic = locale === "ar";
  return (
    <main className="auth-page">
      <div className="auth-page-glow" aria-hidden="true" />
      <header className="auth-topbar">
        <Brand locale={locale} />
        <div className="auth-topbar-actions">
          <LocaleSwitch locale={locale} />
          <a className="auth-home-link" href="/">{isArabic ? "العودة للموقع" : "Back to website"}</a>
        </div>
      </header>
      <div className="auth-main">
        <section className="auth-card">
          <div className="auth-card-motif" aria-hidden="true"><span /><span /><span /></div>
          {children}
        </section>
        <p className="auth-footer-copy">© {new Date().getFullYear()} أفق <span>·</span> {isArabic ? "من العراق، برؤية عالمية" : "From Iraq, with a global outlook"}</p>
      </div>
    </main>
  );
}
