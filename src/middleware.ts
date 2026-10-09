import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { getSupabaseAuthStorageKey, getSupabaseConfig } from "@/lib/supabase/config";

/**
 * Refreshes the Supabase session on every matched request.
 *
 * Why this matters: `supabase.auth.getUser()` in Server Components and Route
 * Handlers (see src/lib/supabase/route-auth.ts) can only read cookies — it
 * cannot write a refreshed access token back to the browser. Without this
 * middleware, a session whose short-lived access token has expired (or a
 * cookie that needs re-chunking after a refresh) is silently dropped, and
 * every server-side `auth.getUser()` call starts returning
 * `{ user: null }` — which is exactly the "Authentication required" error
 * the client portal shows, even though the user is still "logged in" from
 * their point of view.
 *
 * This mirrors Supabase's documented `@supabase/ssr` middleware pattern:
 * build a response, give the client a `cookies.setAll` that writes to BOTH
 * the incoming request (so this request sees the refreshed session) and the
 * outgoing response (so the browser keeps it), then call `getUser()` once to
 * trigger the refresh.
 */
export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const config = getSupabaseConfig();
  if (!config) return response;

  const supabase = createServerClient(config.url, config.anonKey, {
    cookieOptions: { name: getSupabaseAuthStorageKey(config), path: "/" },
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => {
          response.cookies.set(name, value, options);
        });
      },
    },
  });

  // Triggers a token refresh when needed and rewrites the session cookies
  // above via setAll(). The result is not used directly here; each route
  // re-reads the (now fresh) cookies through its own server client.
  await supabase.auth.getUser();

  return response;
}

export const config = {
  matcher: ["/login", "/register", "/forgot-password", "/reset-password", "/dashboard/:path*", "/chat", "/admin/:path*"],
};
