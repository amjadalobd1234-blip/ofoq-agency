import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { getSupabaseAuthStorageKey, getSupabaseConfig } from "@/lib/supabase/config";

const PRIVATE_ROUTES = ["/dashboard", "/chat", "/admin"];
const AUTH_ROUTES = ["/login", "/register", "/forgot-password"];
const FLOW_ROUTES = ["/reset-password"];

function matchesRoute(pathname: string, routes: string[]): boolean {
  return routes.some((route) => pathname === route || pathname.startsWith(`${route}/`));
}

function redirectKeepingCookies(url: URL, response: NextResponse): NextResponse {
  const redirect = NextResponse.redirect(url);
  response.cookies.getAll().forEach((cookie) => redirect.cookies.set(cookie));
  return redirect;
}

export async function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const isPrivate = matchesRoute(pathname, PRIVATE_ROUTES);
  const isAuthPage = matchesRoute(pathname, AUTH_ROUTES);
  const isAuthFlow = matchesRoute(pathname, FLOW_ROUTES);
  if (!isPrivate && !isAuthPage && !isAuthFlow) return NextResponse.next({ request });

  // Keep the site previewable before Supabase settings have been supplied. Each
  // page shows an explicit setup notice rather than pretending auth is active.
  const config = getSupabaseConfig();
  if (!config) return NextResponse.next({ request });

  let response = NextResponse.next({ request });
  const supabase = createServerClient(config.url, config.anonKey, {
    // Same pinned session-cookie name the browser client writes (see lib/supabase/browser.ts).
    // Without this, the proxy base URL makes the browser store the session under
    // a different cookie name and every private page redirects back to /login.
    cookieOptions: { name: getSupabaseAuthStorageKey(config) },
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  // getUser validates the access token with Supabase Auth (not just the cookie).
  const { data: { user } } = await supabase.auth.getUser();

  if (isPrivate && !user) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.searchParams.set("next", `${pathname}${request.nextUrl.search}`);
    return redirectKeepingCookies(loginUrl, response);
  }

  if (pathname === "/admin" || pathname.startsWith("/admin/")) {
    if (!user) {
      const loginUrl = request.nextUrl.clone();
      loginUrl.pathname = "/login";
      loginUrl.searchParams.set("next", "/admin");
      return redirectKeepingCookies(loginUrl, response);
    }

    // The profile's role is read-only to clients and sourced from the database,
    // never from user-editable auth metadata.
    const { data: profile } = await supabase
      .from("users")
      .select("role,status")
      .eq("id", user.id)
      .maybeSingle();
    if (!profile || profile.status !== "ACTIVE" || !["OWNER", "PARTNER"].includes(profile.role)) {
      const dashboardUrl = request.nextUrl.clone();
      dashboardUrl.pathname = "/dashboard";
      dashboardUrl.search = "";
      return redirectKeepingCookies(dashboardUrl, response);
    }
  }

  if (isAuthPage && user) {
    const dashboardUrl = request.nextUrl.clone();
    dashboardUrl.pathname = "/dashboard";
    dashboardUrl.search = "";
    return redirectKeepingCookies(dashboardUrl, response);
  }

  return response;
}

export const config = {
  matcher: ["/login", "/register", "/forgot-password", "/reset-password", "/dashboard/:path*", "/chat", "/admin/:path*"],
};
