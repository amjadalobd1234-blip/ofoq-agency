/**
 * Session diagnostics — «is the browser's Supabase session reaching this API
 * route, and does it belong to the project the API is talking to?»
 *
 * Why this module exists
 * ----------------------
 * Every staff endpoint reads the session from cookies and then calls a
 * SECURITY DEFINER RPC with the caller's JWT. When that RPC fails, the log line
 * `code + message` is not enough to tell these three apart:
 *
 *   1. no session reached the route          → auth.getUser() already failed (401)
 *   2. the session is valid but belongs to a
 *      DIFFERENT Supabase project than
 *      NEXT_PUBLIC_SUPABASE_URL points at    → the RPC «does not exist» there
 *   3. the session is fine and the project is
 *      right, but the RPC is not visible to
 *      the Data API on that project          → PGRST202 / 42883
 *
 * Cases 2 and 3 produce the *same* PostgREST error, which is why the staff page
 * used to say «migration is not installed» for both. This module decodes what
 * the session cookie actually contains — the JWT's `ref` (project reference),
 * `sub`, `role`, `exp` — and compares it with the configured project.
 *
 * Security: values are never logged or returned. Only cookie NAMES, sizes, and
 * the handful of non-secret claims above leave this module. A token is never
 * printed, not even truncated.
 */
import type { SupabasePublicConfig } from "./config";

/** The non-secret parts of a Supabase access token this module cares about. */
export interface JwtClaims {
  /** `ref` — the Supabase project reference the token was minted for. */
  projectRef: string | null;
  /** `role` — always `authenticated` for a signed-in user. */
  role: string | null;
  /** `sub` — the `auth.users.id` of the session. */
  userId: string | null;
  /** `iat` / `exp`, in epoch seconds. */
  issuedAt: number | null;
  expiresAt: number | null;
  /** `iss` — the auth server that issued it (…supabase.co/auth/v1). */
  issuer: string | null;
}

/** A cookie, reduced to what is safe to log. Never carries `value`. */
export interface CookieSummary {
  name: string;
  valueLength: number;
}

export interface AuthCookieSummary extends CookieSummary {
  /** Number of browser cookies the session is split across (`name`, `name.0`, …). */
  chunks: number;
  /** @supabase/ssr prefixes its payload with `base64-`; a missing prefix means another writer. */
  base64Prefixed: boolean;
}

export interface SessionCookieState {
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
  /**
   * True when the cookie holds a refresh token but no access token: the
   * short-lived JWT has already expired and only a refresh (middleware or a
   * route-level `auth.getUser()` write-back) can restore it.
   */
  refreshOnly: boolean;
  /** Claims decoded from the access token — `null` when there is no access token. */
  claims: JwtClaims | null;
}

export interface SessionReport {
  /** Cookies present on the request, names only. */
  cookieCount: number;
  cookieNames: string[];
  /** The cookie name derived from NEXT_PUBLIC_SUPABASE_URL, e.g. `sb-abcdef-auth-token`. */
  expectedAuthCookie: string | null;
  hasExpectedAuthCookie: boolean;
  authCookie: AuthCookieSummary | null;
  /** Any other `sb-*` cookie on the request (a session from another project, an old name). */
  otherAuthCookies: CookieSummary[];
  session: SessionCookieState | null;
  /** Project refs compared: what the session belongs to vs what the API talks to. */
  projectRef: {
    fromSession: string | null;
    fromConfigUrl: string | null;
    /** Explicit mismatch — the single most common «the RPC works in SQL but not in the app». */
    mismatch: boolean;
  };
  /** Human-readable, log-only notes. */
  notes: string[];
}

/** Reads one cookie pair from a `Cookie:` header value. */
export function parseCookieHeader(header: string | null | undefined): Array<{ name: string; value: string }> {
  if (!header) return [];
  const out: Array<{ name: string; value: string }> = [];
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const raw = part.slice(index + 1).trim();
    if (!name) continue;
    // Next.js URL-encodes cookie values it writes; a value the SDK wrote may
    // contain `%` characters of its own, so a failed decode must fall back to
    // the raw text instead of dropping the cookie.
    let value = raw;
    try {
      value = decodeURIComponent(raw);
    } catch {
      value = raw;
    }
    out.push({ name, value });
  }
  return out;
}

/** Cookies on a Request/NextRequest, without touching `next/headers`. */
export function cookiesFromRequest(request: Request): Array<{ name: string; value: string }> {
  return parseCookieHeader(request.headers.get("cookie"));
}

function base64ToUtf8(input: string): string {
  const normalised = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalised.length % 4 === 0 ? normalised : normalised.padEnd(normalised.length + (4 - (normalised.length % 4)), "=");
  return Buffer.from(padded, "base64").toString("utf8");
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Decodes a JWT payload **without verifying the signature**.
 *
 * That is deliberate and safe here: the token was already verified by
 * `auth.getUser()` before any of this is logged, and this function exists only
 * to answer «which project is this cookie for?». Nothing is trusted from it.
 */
export function decodeJwtClaims(token: string): JwtClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(base64ToUtf8(parts[1])) as Record<string, unknown>;
    return {
      projectRef: asString(payload.ref),
      role: asString(payload.role),
      userId: asString(payload.sub),
      issuedAt: asNumber(payload.iat),
      expiresAt: asNumber(payload.exp),
      issuer: asString(payload.iss),
    };
  } catch {
    return null;
  }
}

/** `https://abcdefgh.supabase.co` → `abcdefgh`. Null when the URL is unusable. */
export function projectRefFromSupabaseUrl(url: string | null | undefined): string | null {
  const trimmed = (url ?? "").trim();
  if (!trimmed) return null;
  try {
    const host = new URL(trimmed).hostname;
    const first = host.split(".")[0];
    return first || null;
  } catch {
    // A bare project ref may be passed instead of a URL in some tooling.
    return /^[a-z0-9]{6,}$/i.test(trimmed) ? trimmed : null;
  }
}

/**
 * Reads the Supabase session out of its (possibly chunked, base64) cookie.
 *
 * @supabase/ssr stores one JSON object — `{ access_token, refresh_token, … }` —
 * as `base64-<base64url(json)>`, split across `name`, `name.0`, `name.1` … when
 * it grows past the per-cookie limit. Chunks are concatenated in order, so the
 * reconstructed string is decoded exactly as the SDK wrote it.
 */
export function readSessionCookie(
  cookies: Array<{ name: string; value: string }>,
  cookieName: string,
): { summary: AuthCookieSummary; state: SessionCookieState | null } | null {
  const read = readSessionPayload(cookies, cookieName);
  return read ? { summary: read.summary, state: read.state } : null;
}

/**
 * The raw access token, for outbound Supabase calls made on the session's
 * behalf (the Data API's OpenAPI document is role-dependent, so the diagnostics
 * endpoint must ask as the signed-in user).
 *
 * Never log the return value, and never put it in a response body.
 */
export function readAccessToken(
  cookies: Array<{ name: string; value: string }>,
  cookieName: string,
): string | null {
  return readSessionPayload(cookies, cookieName)?.accessToken ?? null;
}

function readSessionPayload(
  cookies: Array<{ name: string; value: string }>,
  cookieName: string,
): { summary: AuthCookieSummary; state: SessionCookieState | null; accessToken: string | null } | null {
  const exact = cookies.find((cookie) => cookie.name === cookieName);
  const chunks = cookies
    .filter((cookie) => cookie.name.startsWith(`${cookieName}.`))
    .sort((a, b) => Number.parseInt(a.name.slice(cookieName.length + 1), 10) - Number.parseInt(b.name.slice(cookieName.length + 1), 10));
  const pieces = exact ? [exact.value, ...chunks.map((chunk) => chunk.value)] : chunks.map((chunk) => chunk.value);
  if (pieces.length === 0) return null;

  const combined = pieces.join("");
  const summary: AuthCookieSummary = {
    name: cookieName,
    valueLength: combined.length,
    chunks: pieces.length,
    base64Prefixed: combined.startsWith("base64-"),
  };

  const payload = summary.base64Prefixed ? combined.slice("base64-".length) : combined;
  let decoded: Record<string, unknown> | null = null;
  try {
    const text = base64ToUtf8(payload).trim();
    if (text.startsWith("{")) decoded = JSON.parse(text) as Record<string, unknown>;
    else if (text.split(".").length === 3) decoded = { access_token: text };
  } catch {
    decoded = null;
  }

  if (!decoded) {
    return {
      summary,
      state: { hasAccessToken: false, hasRefreshToken: false, refreshOnly: false, claims: null },
      accessToken: null,
    };
  }

  const accessToken = asString(decoded.access_token);
  const refreshToken = asString(decoded.refresh_token);
  return {
    summary,
    state: {
      hasAccessToken: Boolean(accessToken),
      hasRefreshToken: Boolean(refreshToken),
      refreshOnly: !accessToken && Boolean(refreshToken),
      claims: accessToken ? decodeJwtClaims(accessToken) : null,
    },
    accessToken,
  };
}

/**
 * Everything a support log needs about the session on this request.
 *
 * `config` is the same `getSupabaseConfig()` every route uses, so the reported
 * «expectedAuthCookie» is the name this deployment actually reads.
 */
export function describeSession(
  request: Request | null,
  config: SupabasePublicConfig | null,
  cookieName: string | null,
): SessionReport {
  const cookies = request ? cookiesFromRequest(request) : [];
  const expectedAuthCookie = cookieName;
  const session = expectedAuthCookie ? readSessionCookie(cookies, expectedAuthCookie) : null;
  const authCookie = session?.summary ?? null;
  const otherAuthCookies: CookieSummary[] = cookies
    .filter((cookie) => cookie.name.startsWith("sb-") && !(expectedAuthCookie && (cookie.name === expectedAuthCookie || cookie.name.startsWith(`${expectedAuthCookie}.`))))
    .map((cookie) => ({ name: cookie.name, valueLength: cookie.value.length }));

  const fromSession = session?.state?.claims?.projectRef ?? null;
  const fromConfigUrl = projectRefFromSupabaseUrl(config?.url ?? null);

  const notes: string[] = [];
  if (cookies.length === 0) notes.push("the request carries no cookies at all — the browser (or a proxy) did not forward them");
  if (expectedAuthCookie && !authCookie) notes.push(`the expected session cookie ${expectedAuthCookie} is missing`);
  if (session?.state?.refreshOnly) notes.push("the session cookie holds only a refresh token — the access token expired and was not refreshed before this route ran (see the /api/* entries in the middleware matcher)");
  if (session?.summary && !session.summary.base64Prefixed) notes.push("the session cookie has no `base64-` prefix — it was written by something other than @supabase/ssr");
  if (fromSession && fromConfigUrl && fromSession !== fromConfigUrl) {
    notes.push(`the session belongs to project ${fromSession} but NEXT_PUBLIC_SUPABASE_URL points at ${fromConfigUrl} — that project has its own (possibly empty) set of RPCs`);
  }
  if (otherAuthCookies.length > 0) {
    notes.push(`other Supabase cookies are present (${otherAuthCookies.map((cookie) => cookie.name).join(", ")}) — an old project's session, or a proxy-derived cookie name`);
  }

  return {
    cookieCount: cookies.length,
    cookieNames: cookies.map((cookie) => cookie.name),
    expectedAuthCookie,
    hasExpectedAuthCookie: Boolean(authCookie),
    authCookie,
    otherAuthCookies,
    session: session?.state ?? null,
    projectRef: {
      fromSession,
      fromConfigUrl,
      mismatch: Boolean(fromSession && fromConfigUrl && fromSession !== fromConfigUrl),
    },
    notes,
  };
}
