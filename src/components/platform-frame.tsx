import type { ReactNode } from "react";

import type { Locale } from "@/lib/domain/types";
import { PlatformHeader } from "@/components/platform-header";

export function PlatformFrame({ locale, active, title, description, staff = false, children }: {
  locale: Locale;
  active: "dashboard" | "chat" | "admin";
  title: string;
  description?: string;
  staff?: boolean;
  children: ReactNode;
}) {
  return (
    <main className="platform-shell">
      <PlatformHeader locale={locale} staff={staff} active={active} />
      <div className="platform-main">
        <div className="platform-page-heading">
          <span className="eyebrow">{locale === "ar" ? "منصة أفق" : "OFOQ PLATFORM"}</span>
          <h1>{title}</h1>
          {description && <p>{description}</p>}
        </div>
        {children}
      </div>
      <footer className="platform-footer">
        <span>© {new Date().getFullYear()} أفق</span>
        <span>{locale === "ar" ? "معلومات العميل لا تظهر إلا لصاحب الحساب والفريق المخوّل." : "Client information is only available to the account owner and authorised team."}</span>
      </footer>
    </main>
  );
}
