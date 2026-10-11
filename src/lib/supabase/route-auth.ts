import type { User } from "@supabase/supabase-js";
import { cookies } from "next/headers";

import { getSupabaseAuthStorageKey, getSupabaseConfig } from "./config";
import { createSupabaseRouteClient } from "./route-client";
import { createSupabaseServerClient } from "./server";
import { describeSession, type SessionReport } from "./session-diagnostics";
import {
  diagnoseRpcFailure,
  newRequestId,
  rpcFailurePayload,
  type PostgrestErrorLike,
  type RpcFailureContext,
} from "./rpc-diagnostics";

export type { PostgrestErrorLike, RpcFailureContext };

type ServerClient = NonNullable<Awaited<ReturnType<typeof createSupabaseServerClient>>>;

/** What a route gets back once a Supabase session has been confirmed. */
export interface SupabaseSessionAuth {
  client: ServerClient;
  user: User;
  /**
   * Attaches any session cookie the SDK refreshed during this request to the
   * outgoing response. Identity when the ambient cookie store is in use (a
   * route handler's `cookies()` writes are already merged by Next.js).
   */
  finalize: (response: Response) => Response;
  /** Correlates a browser error message with the matching server log line. */
  requestId: string;
  /** Cookie/session facts, already redacted — safe to log. */
  session: SessionReport;
  /**
   * Never set on a success — its presence is what lets callers narrow the
   * return type with the `if (auth.response) return auth.response;` idiom.
   */
  response?: never;
}

/**
 * Confirms the caller's Supabase session.
 *
 * Pass the incoming `Request` from the route handler: the client is then built
 * from THAT request's cookies (and any token it refreshes is written back onto
 * the response). Callers that omit it keep the previous behaviour — the
 * ambient `next/headers` store — which is still correct inside a route handler
 * but cannot report what the request actually carried.
 */
export async function requireSupabaseUser(
  request?: Request,
): Promise<SupabaseSessionAuth | { client?: never; user?: never; finalize?: never; response: Response }> {
  const requestId = newRequestId();
  const config = getSupabaseConfig();
  const cookieName = config ? getSupabaseAuthStorageKey(config) : null;
  const report = describeSession(request ?? null, config, cookieName);
  const routeClient = request ? createSupabaseRouteClient(request) : null;
  const client = routeClient?.client ?? (await createSupabaseServerClient());

  if (!client) {
    return {
      response: Response.json(
        { error: "Supabase Auth is not configured. Add the public Supabase URL and anon key.", code: "SUPABASE_NOT_CONFIGURED", requestId },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      ),
    };
  }

  const { data, error } = await client.auth.getUser();
  if (error || !data.user) {
    // Logged server-side only (Netlify/Cloudflare Function logs). Cookie VALUES
    // are never logged — only names, sizes, and the token's non-secret claims.
    // Reading the report:
    // - cookieCount 0        → browser isn't sending cookies at all.
    // - refreshOnly true     → the access token expired and was not refreshed
    //                          before this route ran (see the middleware matcher).
    // - projectRef.mismatch  → the session belongs to another Supabase project.
    // - hasExpectedAuthCookie → cookie name/format mismatch or an invalid token.
    const ambient = request ? null : await ambientCookieNames();
    // eslint-disable-next-line no-console
    console.error("[route-auth] session rejected", {
      // Same first question every route log answers: did a session arrive?
      hasSession: false,
      requestId,
      route: request ? `${request.method ?? "GET"} ${safePath(request)}` : null,
      ...report,
      ambientCookieNames: ambient,
      authError: error?.message,
      authErrorCode: error?.code,
      authErrorStatus: error?.status,
    });
    return {
      response: Response.json(
        { error: "Authentication required.", code: "AUTH_REQUIRED", requestId },
        { status: 401, headers: { "Cache-Control": "no-store" } },
      ),
    };
  }

  return {
    client,
    user: data.user,
    requestId,
    session: report,
    finalize: routeClient ? routeClient.finalize : (response: Response) => response,
  };
}

/**
 * Cookie names on the ambient `next/headers` store, for the routes that have
 * not been switched to `requireSupabaseUser(request)` yet. Never values.
 */
async function ambientCookieNames(): Promise<string[] | null> {
  try {
    const cookieStore = await cookies();
    return cookieStore.getAll().map((cookie) => cookie.name);
  } catch {
    return null; // Outside a request scope (unit test, background job).
  }
}

function safePath(request: Request): string | null {
  try {
    return new URL(request.url).pathname;
  } catch {
    return null;
  }
}

/**
 * Turns a failed RPC into the browser response AND the log line that explains
 * it. The full PostgREST error (code, message, details, hint) is always logged
 * next to the diagnosis; the browser only ever receives a short, safe message
 * plus — for staff-only routes that ask for it — the next step.
 */
export function rpcFailureResponse(
  error: { code?: string | null; message?: string | null; details?: string | null; hint?: string | null },
  context?: RpcFailureContext & { requestId?: string },
): Response {
  const report = diagnoseRpcFailure(error, context ?? { rpc: "unknown" });
  const requestId = context?.requestId ?? newRequestId();
  // PostgreSQL details stay server-side, but have enough context for support.
  // eslint-disable-next-line no-console
  console.error(`[rpc] ${context?.rpc ?? "unknown"} failed (${report.code})`, {
    requestId,
    kind: report.kind,
    httpStatus: report.status,
    rpc: context?.rpc ?? null,
    args: context?.args ?? null,
    projectRefs: { session: context?.sessionProjectRef ?? null, config: context?.configProjectRef ?? null },
    error: { code: error.code ?? null, message: error.message ?? null, details: error.details ?? null, hint: error.hint ?? null },
    explanation: report.explanation,
    nextStep: report.hint,
  });
  return Response.json(rpcFailurePayload(report, requestId), {
    status: report.status,
    headers: { "Cache-Control": "no-store" },
  });
}

/** The caller's own profile row, as far as RLS and column grants allow. */
export interface SupabaseProfile {
  id: string;
  name: string | null;
  email: string | null;
  /** OWNER | PARTNER | CLIENT (validated by the database constraint). */
  role: "OWNER" | "PARTNER" | "CLIENT";
  status: string;
  locale: string | null;
}

const PROFILE_COLUMNS = "id, name, email, role, status, locale";

/**
 * Reads the signed-in user's own profile with the caller's JWT.
 *
 * `public.users` is protected by the `ofoq_user_read_self` policy plus column
 * grants, so this can only ever return the caller's own row — which is exactly
 * what an API route needs to answer "is this user staff?".
 */
export async function fetchOwnProfile(
  client: ServerClient,
  userId: string,
): Promise<{ profile: SupabaseProfile; error?: never } | { profile?: never; error: PostgrestErrorLike }> {
  const { data, error } = await client
    .from("users")
    .select(PROFILE_COLUMNS)
    .eq("id", userId)
    .maybeSingle();
  if (error) return { error };
  if (!data) return { error: { code: "NO_PROFILE", message: "No platform profile for this account." } };
  return { profile: data as SupabaseProfile };
}

function inactiveSessionResponse(): Response {
  return Response.json(
    { error: "Your session is not active. Sign in again or contact the agency.", code: "SESSION_INACTIVE" },
    { status: 403, headers: { "Cache-Control": "no-store" } },
  );
}

/** Why a staff gate refused the request. `read_failed` is a database problem. */
export type ProfileFailureReason = "no_profile" | "inactive" | "forbidden" | "read_failed";

/**
 * Route guard for staff-only or owner-only endpoints.
 *
 * Returns the profile when the caller holds one of `allowed` roles and the
 * account is ACTIVE; otherwise a ready-to-return Response. The database still
 * re-checks every staff RPC, so this is an early, friendlier gate — not the only
 * line of defence.
 *
 * A failed *read* (a missing column, a stale schema cache, a partial migration
 * on `public.users`) is reported separately from a failed *authorisation*: it
 * comes back with `reason: "read_failed"` and the raw PostgREST `error`, so the
 * calling route can log it as «the profile table, not the alert RPC».
 */
export async function requireOwnRole(
  client: ServerClient,
  userId: string,
  allowed: readonly SupabaseProfile["role"][],
  context?: { requestId?: string },
): Promise<
  | { profile: SupabaseProfile; response?: never; reason?: never; error?: never }
  | { profile?: never; response: Response; reason: ProfileFailureReason; error?: PostgrestErrorLike }
> {
  const { profile, error } = await fetchOwnProfile(client, userId);
  if (!profile) {
    if (error?.code === "NO_PROFILE") {
      return { response: inactiveSessionResponse(), reason: "no_profile" };
    }
    return {
      response: rpcFailureResponse(error ?? {}, {
        rpc: "readOwnProfile",
        // The table and the exact columns the app selected. A missing column is
        // the difference between «apply the migration» and «your schema cache
        // is stale», and PostgREST's own message names it.
        args: { table: "public.users", select: PROFILE_COLUMNS.replaceAll(", ", ",") },
        resource: `public.users (${PROFILE_COLUMNS})`,
        codeOverride: "PROFILE_READ_FAILED",
        messageOverride:
          "Your staff profile could not be read from the database (public.users). The portal SQL is applied only partially, or the Data API's schema cache is stale.",
        exposeHint: true,
        requestId: context?.requestId,
      }),
      reason: "read_failed",
      error: error ?? {},
    };
  }
  if (profile.status !== "ACTIVE") {
    return { response: inactiveSessionResponse(), reason: "inactive" };
  }
  if (!allowed.includes(profile.role)) {
    return {
      response: Response.json(
        { error: "You do not have permission for this action.", code: "ROLE_FORBIDDEN" },
        { status: 403, headers: { "Cache-Control": "no-store" } },
      ),
      reason: "forbidden",
    };
  }
  return { profile };
}
