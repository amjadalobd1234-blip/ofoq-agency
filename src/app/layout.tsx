import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "أُفق | استوديو إبداعي واستراتيجي",
    template: "%s | أُفق",
  },
  description:
    "أُفق استوديو إبداعي من العراق، نبني للعلامات الطموحة حضوراً مؤثراً عبر الاستراتيجية والهوية والتجارب الرقمية والنمو.",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="ar" dir="rtl">
      <body>{children}</body>
    </html>
  );
}
