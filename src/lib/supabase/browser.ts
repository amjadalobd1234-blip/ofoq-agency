"use client";

import { createBrowserClient } from "@supabase/ssr";

import { getSupabaseAuthStorageKey, getSupabaseBrowserBaseUrl, getSupabaseConfig } from "./config";

let browserClient: ReturnType<typeof createBrowserClient> | null = null;

/**
 * Browser Supabase client.
 *
 * When `NEXT_PUBLIC_SUPABASE_PROXY_URL` is set (e.g. "/api/supabase-proxy"),
 * every call is routed through the same-origin proxy so it works on networks
 * that block `*.supabase.co` at the ISP level. Otherwise it talks to the
 * project URL directly.
 */
export function createSupabaseBrowserClient() {
  const config = getSupabaseConfig();
  if (!config) return null;
  browserClient ??= createBrowserClient(getSupabaseBrowserBaseUrl(config), config.anonKey, {
    // Pin the session cookie name to the key derived from the real project URL.
    // With the proxy enabled the base URL hostname differs from the project's,
    // and supabase-js would otherwise derive a different default storage key —
    // the middleware would then never see the session cookie and logins would
    // silently bounce back to /login.
    // `path: "/"` is explicit (not just the default) so the cookie set while
    // on /login is still sent on /dashboard and /api/* requests. Without it,
    // some browsers scope the cookie to the current path and the very first
    // server-side read after a fresh login comes back with no session.
    cookieOptions: { name: getSupabaseAuthStorageKey(config), path: "/" },
  });
  return browserClient;
}
