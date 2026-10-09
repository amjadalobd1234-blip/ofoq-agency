import { getSupabaseConfig } from "@/lib/supabase/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * /api/debug/remote — تشخيص اتصال Supabase من خادم Netlify نفسه.
 *
 * الغرض: فصل السببين المتنافسين لخطأ "Failed to fetch":
 *  - إذا فشل الخادم أيضًا → مشروع Supabase متوقف/محذوف/الرابط خاطئ (ليس المتصفح ولا CSP).
 *  - إذا نجح الخادم والمتصفح يفشل → حظر محلي (إضافات، مضاد فيروسات، بروكسي، DNS، CSP).
 *
 * لا يُعيد هذا المسار أي أسرار: طول المفتاح وبادئته فقط.
 */

interface ProbeResult {
  name: string;
  ok: boolean;
  status: number | null;
  ms: number;
  error: string | null;
  bodySnippet: string | null;
}

async function probe(name: string, url: string, headers: Record<string, string>): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    const bodySnippet = (await response.text()).slice(0, 200);
    return { name, ok: response.ok, status: response.status, ms: Date.now() - started, error: null, bodySnippet };
  } catch (error) {
    const err = error as Error;
    return {
      name,
      ok: false,
      status: null,
      ms: Date.now() - started,
      error: `${err.name}: ${err.message}`.slice(0, 200),
      bodySnippet: null,
    };
  }
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2 || !parts[1]) return null;
  try {
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "===".slice((normalized.length + 3) % 4);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function GET(): Promise<Response> {
  const config = getSupabaseConfig();

  if (!config) {
    return Response.json(
      {
        configured: false,
        verdict: "supabase_not_configured",
        detail: "NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY غير مضبوطتين في بناء النشر.",
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }

  let urlHost = "INVALID_URL";
  try {
    urlHost = new URL(config.url).host;
  } catch {
    /* keep placeholder */
  }
  const projectRefFromHost = urlHost.replace(/\.supabase\.co$/, "");
  const payload = config.anonKey.includes(".") ? decodeJwtPayload(config.anonKey) : null;
  const keyRef = typeof payload?.ref === "string" ? (payload.ref as string) : "";

  const checks: ProbeResult[] = [];
  checks.push(await probe("GET /auth/v1/health", `${config.url}/auth/v1/health`, { apikey: config.anonKey }));
  checks.push(await probe("GET /auth/v1/settings", `${config.url}/auth/v1/settings`, { apikey: config.anonKey }));
  checks.push(await probe("GET / (root)", config.url, {}));

  const networkFailures = checks.filter((c) => c.status === null);
  const anyOk = checks.some((c) => c.ok);
  const anyResponse = checks.some((c) => c.status !== null);

  let verdict: string;
  let detail: string;
  if (networkFailures.length === checks.length) {
    verdict = "server_cannot_reach_supabase";
    detail =
      "الخادم لا يصل إلى رابط مشروع Supabase إطلاقًا (فشل TCP/TLS/DNS). السبب غالبًا: مشروع متوقف (Paused) أو محذوف أو ref خاطئ. ليست مشكلة متصفح أو CSP.";
  } else if (anyOk) {
    verdict = "server_reaches_supabase";
    detail =
      "الخادم يصل إلى Supabase بنجاح. إن فشل المتصفح فإن المشكلة محليًا عندك: مانع إعلانات/مضاد فيروسات/VPN/بروكسي/DNS أو CSP في المتصفح.";
  } else if (anyResponse) {
    verdict = "server_reaches_but_http_errors";
    detail =
      "الخادم يتلقى ردود HTTP لكن ليست ناجحة — المضيف يعمل. راجع الأكواد أدناه (401/403 = مفتاح مرفوض؛ 5xx = مشكلة مشروع).";
  } else {
    verdict = "unknown";
    detail = "نتيجة غير حاسمة.";
  }

  return Response.json(
    {
      configured: true,
      checkedAt: new Date().toISOString(),
      node: process.version,
      target: {
        urlHost,
        projectRefFromHost,
        keyLength: config.anonKey.length,
        keyPrefix: `${config.anonKey.slice(0, 12)}…`,
        keyLooksLikeLegacyJwt: config.anonKey.startsWith("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"),
        keyLooksLikePublishable: config.anonKey.startsWith("sb_publishable_"),
        keyRef,
        keyRefMatchesHost: keyRef ? keyRef === projectRefFromHost : null,
      },
      checks,
      verdict,
      detail,
    },
    { status: 200, headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}
