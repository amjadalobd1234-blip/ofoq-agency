export interface SupabasePublicConfig {
  url: string;
  anonKey: string;
  /**
   * Optional browser-facing base URL that routes Supabase traffic through the
   * same-origin proxy (`/api/supabase-proxy`). Used where ISPs block the
   * `*.supabase.co` domain (e.g. some networks in Iraq). `null` when the
   * browser should talk to Supabase directly.
   */
  proxyUrl: string | null;
}

/**
 * Validated value of NEXT_PUBLIC_SUPABASE_PROXY_URL.
 * Accepts a same-origin path ("/api/supabase-proxy") or an absolute https URL.
 * Anything else (protocol-relative "//host", "javascript:", …) is rejected.
 */
function readProxyUrl(): string | null {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_PROXY_URL?.trim().replace(/\/+$/, "");
  if (!raw) return null;
  if (raw.startsWith("/")) {
    // Same-origin path. Reject protocol-relative ("//evil.com") and oddities.
    if (raw.startsWith("//") || raw.includes("://") || raw.includes("\\") || raw.includes("..")) return null;
    return raw;
  }
  try {
    const parsed = new URL(raw);
    const localHttp = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    if (parsed.protocol !== "https:" && !localHttp) return null;
    return raw;
  } catch {
    return null;
  }
}

/** Public Supabase settings only. A service-role key is deliberately not supported. */
export function getSupabaseConfig(): SupabasePublicConfig | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/\/+$/, "");
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!url || !anonKey) return null;

  try {
    const parsed = new URL(url);
    const localHttp = process.env.NODE_ENV !== "production" &&
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
    if (parsed.protocol !== "https:" && !localHttp) return null;
    return { url, anonKey, proxyUrl: readProxyUrl() };
  } catch {
    return null;
  }
}

export function isSupabaseConfigured(): boolean {
  return getSupabaseConfig() !== null;
}

/**
 * Name of the cookie that carries the Supabase session.
 *
 * supabase-js derives this by default as `sb-<first hostname label>-auth-token`
 * from the URL each client is created with. The browser client may be pointed
 * at the same-origin proxy (see getSupabaseBrowserBaseUrl), whose hostname
 * differs from the project's — so unless the name is pinned explicitly, the
 * browser stores the session under a different cookie than the middleware and
 * route handlers read (they always use `config.url`). Freshly signed-in users
 * would then be bounced from every private page back to /login. Both sides
 * must agree on this value.
 */
export function getSupabaseAuthStorageKey(config: SupabasePublicConfig): string {
  const projectRef = new URL(config.url).hostname.split(".")[0];
  return `sb-${projectRef}-auth-token`;
}

/**
 * Base URL the **browser** client must use.
 *
 * - Proxy configured → resolve it against the page origin (a relative
 *   "/api/supabase-proxy" becomes "https://site…/api/supabase-proxy") so
 *   every auth/REST call goes browser → Netlify → Supabase and works even
 *   where `*.supabase.co` is blocked at the ISP level.
 * - Otherwise → the project URL directly (unblocked networks).
 *
 * Server-side clients (middleware, route handlers) must keep using
 * `config.url` — Netlify's servers reach Supabase directly, and the proxy
 * must not loop back through itself.
 */
export function getSupabaseBrowserBaseUrl(config: SupabasePublicConfig): string {
  if (!config.proxyUrl || typeof window === "undefined") return config.url;
  try {
    return new URL(config.proxyUrl, window.location.origin).toString().replace(/\/+$/, "");
  } catch {
    return config.url;
  }
}
