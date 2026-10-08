import type { Metadata } from "next";
import type { ReactNode } from "react";

import { dir, getLocale } from "@/lib/i18n";

import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "أفق | منصة التسويق الذكي",
    template: "%s | أفق",
  },
  description:
    "أفق منصة تسويق رقمي تجمع العملاء والمشاريع والمحادثات الذكية في مساحة واحدة، بهوية عراقية ورؤية عالمية.",
};

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const locale = await getLocale();
  return (
    <html lang={locale} dir={dir(locale)}>
      <body>{children}</body>
    </html>
  );
}
