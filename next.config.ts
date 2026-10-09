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
  // ⚠️ TEMPORARY — CSP DISABLED FOR DIAGNOSTIC TESTING ONLY.
  // The connect-src below is being removed to test whether CSP is blocking
  // the browser's fetch to Supabase (Test Fetch on /debug fails with
  // "NetworkError — Failed to fetch"). REVERT THIS COMMIT once the root
  // cause is confirmed — do NOT merge this to main without a final decision.
  // {
  //   key: "Content-Security-Policy",
  //   value: [
  //     "default-src 'self'",
  //     // Next.js injects inline bootstrap scripts; 'unsafe-inline' is required unless nonces are wired up.
  //     `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  //     "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  //     "font-src 'self' data: https://fonts.gstatic.com",
  //     "img-src 'self' data: blob: https:",
  //     "connect-src 'self' https://sltgxlrfscpchulobazb.supabase.co wss://sltgxlrfscpchulobazb.supabase.co https://*.supabase.co",
  //     "frame-ancestors 'self'",
  //     "base-uri 'self'",
  //     "form-action 'self'",
  //   ].join("; "),
  // },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  serverExternalPackages: ["better-sqlite3"],
  logging: {
    fetches: { fullUrl: false },
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
