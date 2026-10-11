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
 *
 * Which paths are matched
 * -----------------------
 * Every surface that reads the session server-side is listed in `config.matcher`
 * below — the pages AND the API routes they call (`/api/admin/:path*`,
 * `/api/dashboard`, `/api/me`). An API route that is not matched still receives
 * the browser's cookies, but nothing refreshes them: an expired access token
 * then fails at `auth.getUser()` and the staff page reports an auth error even
 * though the same user just used a page successfully.
 *
 * Deliberately NOT matched:
 * - `/api/supabase-proxy/:path*` — it is the same-origin tunnel every browser
 *   auth/REST call goes through. Refreshing here would add a Supabase round-trip
 *   to every proxied request (and a refresh loop risk if Supabase is unreachable).
 * - `/api/ai/chat` and `/api/chat` — both accept work before a session exists;
 *   each route still calls `requireSupabaseUser()` itself.
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
  matcher: [
    // Pages that render a signed-in surface.
    "/login",
    "/register",
    "/forgot-password",
    "/reset-password",
    "/dashboard/:path*",
    "/chat",
    "/admin/:path*",
    // API routes those pages call: without an entry here their request can
    // carry an access token that expired since the last page navigation.
    "/api/admin/:path*",
    "/api/dashboard",
    "/api/me",
  ],
};
