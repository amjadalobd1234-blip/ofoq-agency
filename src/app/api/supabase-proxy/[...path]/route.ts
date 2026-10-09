import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * /api/supabase-proxy/[...path] — وسيط Supabase عبر Netlify.
 *
 * المشكلة: مزودو إنترنت في بعض الدول (العراق وغيرها) يحجبون نطاق `*.supabase.co`
 * بالكامل على مستوى الشبكة، بينما نطاق لوحة التحكم `supabase.com` يبقى متاحًا.
 * حلّ الوسيط: المتصفح يرسل الطلبات إلى نفس نطاق الموقع (Netlify) — وسيرفرات
 * Netlify (أمريكا/أوروبا) تتصل بـ Supabase وتُعيد الرد. العملاء في الشبكات
 * المحجوبة يسجلون ويدخلون بدون VPN.
 *
 * التصميم:
 * - الوجهة ثابتة على `NEXT_PUBLIC_SUPABASE_URL` (أو `SUPABASE_URL` الخادمي) —
 *   ليس بروكسي مفتوحًا؛ لا يمكن استخدامه للوصول لأي مضيف آخر.
 * - يمرر كل المسارات (auth/v1, rest/v1, storage/v1, functions/v1, …)
 *   ونفس الـ headers (apikey, authorization, …) وquery string والجسم كما هي.
 * - يمرر ردود 3xx (Location) كما هي حتى تعمل روابط التحقق/الـ OAuth.
 * - بدون CORS: النداء من نفس النطاق (same-origin) فلا حاجة لرؤوس CORS إطلاقًا.
 *
 * القيود الموثقة:
 * - WebSocket (Realtime) لا يمر عبر وسيط HTTP — هذا المشروع لا يستخدم Realtime.
 * - روابط تأكيد البريد الافتراضية تشير إلى `*.supabase.co` مباشرة (محجوبة)؛
 *   الحل: تعطيل Confirm email أو قالب بريد يمرر الرابط عبر الوسيط (docs/DEPLOY-AR.md).
 * - Google OAuth يحتاج تنقّل متصفح إلى supabase.co في منتصف المسار — لا يعمل
 *   عبر الوسيط. البريد/كلمة المرور تعمل كاملة.
 */

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  // Re-computed by the runtime for the body we return.
  "content-length",
  "content-encoding",
]);

const REQUEST_HEADERS_TO_DROP = new Set([
  ...HOP_BY_HOP_HEADERS,
  "host",
  // Let undici negotiate compression with Supabase; we return decoded bodies.
  "accept-encoding",
]);

const RESPONSE_HEADERS_TO_DROP = new Set([
  ...HOP_BY_HOP_HEADERS,
  // Netlify owns transport security for our origin.
  "strict-transport-security",
]);

function targetBase(): string | null {
  const raw = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").trim().replace(/\/+$/, "");
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    const localHttp =
      process.env.NODE_ENV !== "production" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
    if (parsed.protocol !== "https:" && !localHttp) return null;
    return raw;
  } catch {
    return null;
  }
}

function buildTarget(base: string, pathSegments: string[], search: string): string | null {
  for (const segment of pathSegments) {
    if (!segment || segment === "." || segment === "..") return null;
    if (segment.includes("/") || segment.includes("\\") || segment.includes(":") || segment.includes("\0")) return null;
  }
  if (pathSegments.length === 0) {
    // /api/supabase-proxy with no sub-path — harmless project root probe.
    return `${base}/${search}`;
  }
  return `${base}/${pathSegments.join("/")}${search}`;
}

function securityCheck(request: NextRequest): Response | null {
  // Browsers mark cross-site subresource calls; block casual embedding of this
  // proxy on third-party sites. Non-browser clients omit the header entirely
  // (they could reach Supabase directly anyway).
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "same-site" && fetchSite !== "none") {
    return Response.json(
      { error: "This proxy only serves requests from the Ofoq platform origin." },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }
  return null;
}

async function forward(request: NextRequest, pathSegments: string[]): Promise<Response> {
  const blocked = securityCheck(request);
  if (blocked) return blocked;

  const base = targetBase();
  if (!base) {
    return Response.json(
      { error: "Supabase proxy is not configured on the server (NEXT_PUBLIC_SUPABASE_URL missing)." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  const target = buildTarget(base, pathSegments, request.nextUrl.search);
  if (!target) {
    return Response.json({ error: "Invalid proxy path." }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }

  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (!REQUEST_HEADERS_TO_DROP.has(key.toLowerCase())) headers.set(key, value);
  });
  // Identify proxied traffic in Supabase logs without breaking SDK checks.
  headers.set("x-forwarded-host", request.headers.get("host") ?? "");

  const method = request.method.toUpperCase();
  const hasBody = !["GET", "HEAD", "OPTIONS"].includes(method);
  const body = hasBody ? await request.arrayBuffer() : undefined;

  try {
    const upstream = await fetch(target, {
      method,
      headers,
      body,
      redirect: "manual", // pass 3xx through so verify/OAuth redirects reach the browser
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });

    const responseHeaders = new Headers();
    upstream.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (!RESPONSE_HEADERS_TO_DROP.has(lower) && lower !== "set-cookie") responseHeaders.set(key, value);
    });
    const cookies = typeof upstream.headers.getSetCookie === "function" ? upstream.headers.getSetCookie() : [];
    for (const cookie of cookies) responseHeaders.append("set-cookie", cookie);

    if (upstream.status === 204 || upstream.status === 205 || method === "HEAD") {
      return new Response(null, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders });
    }
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders });
  } catch (error) {
    const err = error as Error;
    return Response.json(
      {
        error: "Supabase is unreachable from the proxy right now.",
        detail: `${err.name}: ${err.message}`.slice(0, 200),
      },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}

type RouteContext = { params: Promise<{ path?: string[] }> };

export async function GET(request: NextRequest, context: RouteContext) {
  return forward(request, (await context.params).path ?? []);
}
export async function POST(request: NextRequest, context: RouteContext) {
  return forward(request, (await context.params).path ?? []);
}
export async function PUT(request: NextRequest, context: RouteContext) {
  return forward(request, (await context.params).path ?? []);
}
export async function PATCH(request: NextRequest, context: RouteContext) {
  return forward(request, (await context.params).path ?? []);
}
export async function DELETE(request: NextRequest, context: RouteContext) {
  return forward(request, (await context.params).path ?? []);
}
export async function HEAD(request: NextRequest, context: RouteContext) {
  return forward(request, (await context.params).path ?? []);
}
export async function OPTIONS(request: NextRequest, context: RouteContext) {
  // Same-origin calls never need a preflight, but answer politely anyway.
  const response = await forward(request, (await context.params).path ?? []);
  response.headers.set("Access-Control-Allow-Origin", request.headers.get("origin") ?? "*");
  response.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "apikey, authorization, content-type, x-client-info, x-supabase-api-version, accept-profile, prefer, range");
  response.headers.set("Access-Control-Max-Age", "86400");
  return response;
}
