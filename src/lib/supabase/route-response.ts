/**
 * Small helpers that keep the routes readable.
 *
 * `finalizeResponse()` exists because a route may be handed an auth object from
 * a test double (the vitest suites replace `@/lib/supabase/route-auth`), and
 * that object has no cookie writer. Attaching cookies is then simply a no-op
 * instead of a crash — the route's own behaviour stays identical.
 */
export interface FinalizableAuth {
  finalize?: (response: Response) => Response;
}

/** Attaches the session cookies a route client refreshed, when there are any. */
export function finalizeResponse(auth: FinalizableAuth | null | undefined, response: Response): Response {
  return typeof auth?.finalize === "function" ? auth.finalize(response) : response;
}

/** `Response.json()` plus the refreshed session cookies, `no-store` by default. */
export function jsonWithSession(
  auth: FinalizableAuth | null | undefined,
  body: unknown,
  init?: ResponseInit,
): Response {
  const headers = new Headers(init?.headers);
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-store, max-age=0");
  return finalizeResponse(auth, Response.json(body, { ...init, headers }));
}
