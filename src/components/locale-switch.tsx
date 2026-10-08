"use client";

import { useRouter } from "next/navigation";

import type { Locale } from "@/lib/domain/types";

export function LocaleSwitch({ locale }: { locale: Locale }) {
  const router = useRouter();
  const nextLocale = locale === "ar" ? "en" : "ar";

  function switchLocale() {
    const secure = window.location.protocol === "https:" ? ";Secure" : "";
    document.cookie = `ofoq_locale=${nextLocale};Path=/;Max-Age=31536000;SameSite=Lax${secure}`;
    document.documentElement.lang = nextLocale;
    document.documentElement.dir = nextLocale === "ar" ? "rtl" : "ltr";
    router.refresh();
  }

  return (
    <button className="locale-switch" type="button" onClick={switchLocale} aria-label={locale === "ar" ? "Switch language to English" : "غيّر اللغة إلى العربية"}>
      <span aria-hidden="true">文</span>
      <span className="locale-switch-label">{locale === "ar" ? "English" : "العربية"}</span>
    </button>
  );
}
