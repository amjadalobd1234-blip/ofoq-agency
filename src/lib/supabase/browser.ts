"use client";

import { createBrowserClient } from "@supabase/ssr";

import { getSupabaseBrowserBaseUrl, getSupabaseConfig } from "./config";

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
  browserClient ??= createBrowserClient(getSupabaseBrowserBaseUrl(config), config.anonKey);
  return browserClient;
}
