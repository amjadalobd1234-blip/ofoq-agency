import type { NextConfig } from "next";

/**
 * Ofoq platform — Next.js configuration.
 *
 * Notes:
 * - `better-sqlite3` is a native module and must stay outside the bundler.
 * - Security headers are applied globally (see docs/SECURITY.md).
 * - `APP_URL` / `APP_DOMAIN` are configuration values only; nothing assumes the
 *   domain has been purchased or connected.
 */
const isDev = process.env.NODE_ENV !== "production";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-DNS-Prefetch-Control", value: "on" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  // ⚠️ CSP مؤقتًا مُعطَّلة — قرار موثّق، وليس إهمالًا.
  // التشخيص أثبت أن سبب "Failed to fetch" ليس CSP:
  //  - فشل الاتصال يستمر بعد حذف CSP بالكامل.
  //  - اختبارات مستقلة (خارج المتصفح) لا تصل إلى رابط المشروع
  //    `https://sltgxlrfscpchulobazb.supabase.co` على مستوى الشبكة إطلاقًا،
  //    بينما تعمل مواقع أخرى طبيعيًا — أي أن المشروع نفسه لا يستجيب.
  // تبقى CSP مُعطَّلة فقط خلال فترة التشخيص حتى لا تحظر اختبارات /debug
  // (مثل example.com/google.com) وتُنتج نتائج إيجابية كاذبة.
  //
  // ✅ بعد التأكد من حل المشكلة (إعادة تفعيل مشروع Supabase + نشر نظيف):
  //    1) أعد تفعيل كتلة CSP بالأسفل (connect-src يغطي Supabase بالفعل).
  //    2) احذف هذا التنبيه.
  //    3) تأكد من /debug أن "رأس CSP" يظهر الكتلة وconnect-src يسمح بـ https://*.supabase.co.
  // {
  //   key: "Content-Security-Policy",
  //   value: [
  //     "default-src 'self'",
  //     // Next.js injects inline bootstrap scripts; 'unsafe-inline' is required unless nonces are wired up.
  //     `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  //     "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  //     "font-src 'self' data: https://fonts.gstatic.com",
  //     "img-src 'self' data: blob: https:",
  //     "connect-src 'self' https://sltgxlrfscpchulobazb.supabase.co wss://sltgxlrfscpchulobazb.supabase.co https://*.supabase.co wss://*.supabase.co",
  //     "frame-ancestors 'self'",
  //     "base-uri 'self'",
  //     "form-action 'self'",
  //   ].join("; "),
  // },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Both are runtime-only server dependencies: `better-sqlite3` is a native
  // module, and `pg` is loaded lazily by the PostgreSQL driver when
  // DATABASE_URL is configured. Keeping them external also makes the file
  // trace of the deployed routes include them — without this, a serverless
  // deployment could ship the driver without the `pg` package.
  serverExternalPackages: ["better-sqlite3", "pg"],
  logging: {
    fetches: { fullUrl: false },
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
