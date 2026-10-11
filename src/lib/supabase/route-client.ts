/**
 * Request-scoped Supabase client for Route Handlers.
 *
 * Why not `createSupabaseServerClient()` (src/lib/supabase/server.ts)?
 * -------------------------------------------------------------------
 * That one reads the ambient `next/headers` cookie store. It works in a route
 * handler, but the session it sees is only as good as the framework's request
 * context — and a cookie the SDK refreshes mid-request is written back through
 * a store the route never sees. This module makes the contract explicit, which
 * is the pattern Supabase documents for route handlers:
 *
 *   1. read the cookies off the incoming Request,
 *   2. let the SDK write refreshed ones,
 *   3. attach those `Set-Cookie` headers to the response we return.
 *
 * The diagnostics (cookie names, session project ref) come from the same
 * request, so a log line describes exactly what this route saw.
 */
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse } from "next/server";

import { getSupabaseAuthStorageKey, getSupabaseConfig } from "./config";
import { cookiesFromRequest } from "./session-diagnostics";

export interface WrittenSessionCookie {
  name: string;
  value: string;
  options?: CookieOptions;
}

export interface SupabaseRouteClient {
  client: ReturnType<typeof createServerClient>;
  /** Names of the cookies this client read from the request. */
  readCookieNames: string[];
  /** Names of the cookies the SDK rewrote (a token refresh happened). */
  writtenCookieNames: () => string[];
  /** Returns the same response with those refreshed cookies attached. */
  finalize: (response: Response) => Response;
}

/**
 * Builds the Supabase client for one incoming Request, or null when the
 * deployment has no NEXT_PUBLIC_SUPABASE_URL / ANON_KEY.
 */
export function createSupabaseRouteClient(request: Request): SupabaseRouteClient | null {
  const config = getSupabaseConfig();
  if (!config) return null;

  const incoming = cookiesFromRequest(request);
  const written: WrittenSessionCookie[] = [];

  const client = createServerClient(config.url, config.anonKey, {
    cookieOptions: { name: getSupabaseAuthStorageKey(config), path: "/" },
    cookies: {
      getAll() {
        return incoming.map((cookie) => ({ name: cookie.name, value: cookie.value }));
      },
      setAll(cookiesToSet) {
        // Collected instead of written through `next/headers`: a route handler
        // owns its Response, so the refreshed session is attached there.
        for (const { name, value, options } of cookiesToSet) {
          const index = written.findIndex((cookie) => cookie.name === name);
          if (index >= 0) written[index] = { name, value, options };
          else written.push({ name, value, options });
        }
      },
    },
  });

  return {
    client,
    readCookieNames: incoming.map((cookie) => cookie.name),
    writtenCookieNames: () => written.map((cookie) => cookie.name),
    finalize(response: Response): Response {
      const refreshed = written.filter((cookie) => cookie.value !== undefined);
      if (refreshed.length === 0) return response;
      const next = new NextResponse(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: new Headers(response.headers),
      });
      for (const { name, value, options } of refreshed) {
        next.cookies.set(name, value, options as Parameters<typeof next.cookies.set>[2]);
      }
      return next;
    },
  };
}
