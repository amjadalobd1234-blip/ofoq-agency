import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "أفق | منصة وكالة تسويق رقمي",
    template: "%s | أفق",
  },
  description:
    "أفق منصة تساعد وكالات التسويق الرقمي على تنظيم العملاء والمشاريع والعروض ومتابعة العمل في مكان واحد.",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="ar" dir="rtl">
      <body>{children}</body>
    </html>
  );
}
