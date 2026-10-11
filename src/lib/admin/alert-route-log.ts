/**
 * One log line for every way `/admin/alerts` (and its detail page) can fail.
 *
 * Why a dedicated module
 * ----------------------
 * The staff page can end up showing «Supabase portal migration is not installed
 * yet» for four different reasons, and three of them are NOT the alert RPCs:
 *
 *   1. no session reached the route at all   → 401 (the page shows «session»,
 *                                              never the migration sentence)
 *   2. the caller's own profile row in `public.users` could not be read
 *      (partial migration, missing column, stale schema cache, RLS) — the route
 *      never reaches the RPC, yet the message is the same sentence
 *   3. the RPC itself is not exposed to the Data API (PGRST202 / 42883 / 42P01)
 *   4. a token that was expired was not refreshed before the call
 *
 * Before this helper, only (3) wrote an `[api/admin/alerts]` line: (2) produced
 * a bare `[rpc] fetchOwnProfile failed` with no session, no user and no cookie
 * count — so «check the logs» had nothing to find.
 *
 * The line is a single object, always under the same prefix, and always carries
 * `hasSession`, `userId`, `cookieCount` and `rpcError`, so filtering the host's
 * function logs for `[admin-alerts]` is enough to see what the deployment saw.
 *
 * Never logged: cookie values, access/refresh tokens, message bodies, row data.
 */
import type { PostgrestErrorLike } from "@/lib/supabase/rpc-diagnostics";
import { describeRequestSession, type SessionReport } from "@/lib/supabase/session-diagnostics";

/** What the route was doing when it failed. */
export type AdminAlertFailureReason =
  /** No valid session for this request. */
  | "auth_required"
  /** The caller has no profile row (or it is not ACTIVE, or the role is wrong). */
  | "profile"
  /** A session was confirmed, but an RPC call was refused. */
  | "rpc";

export interface AdminAlertFailureLog {
  /** The incoming Request — the session facts are read from it when not supplied. */
  request: Request;
  /** e.g. `GET /api/admin/alerts`. */
  route: string;
  /** e.g. `list`, `details`, `acknowledge`, `resolve`, `reply`. */
  action: string;
  reason: AdminAlertFailureReason;
  /** Set once a session was confirmed. */
  userId?: string | null;
  userEmail?: string | null;
  /** The caller's platform role, when it could be read. */
  userRole?: string | null;
  /** Correlates the browser error with this line. */
  requestId?: string | null;
  /**
   * The session report — pass the one from `requireSupabaseUser()` to avoid
   * re-reading the request. `null` is a real value: no session was confirmed.
   */
  session?: SessionReport | null;
  /** The RPC (or table read) that failed, e.g. `ofoq_admin_alerts`. */
  rpc?: string | null;
  /** Argument NAMES only; values are placeholders, never customer data. */
  rpcArgs?: Record<string, string> | null;
  /** The complete PostgREST error — code, message, details, hint. */
  rpcError?: PostgrestErrorLike | null;
  /** Free-text, log-only detail (e.g. `partial profile`, `not ACTIVE`). */
  note?: string | null;
}

/**
 * Writes the failure line. Returns nothing: the caller returns its own Response,
 * and a logging failure must never change an HTTP status.
 */
export function logAdminAlertFailure(entry: AdminAlertFailureLog): void {
  const session = entry.session ?? safeDescribe(entry.request);
  // eslint-disable-next-line no-console
  console.error("[admin-alerts]", {
    route: entry.route,
    action: entry.action,
    reason: entry.reason,
    // The four fields to read first. `hasSession` is about a CONFIRMED session:
    // it stays false when a cookie arrived but its token was refused, which is
    // the difference between «nothing was sent» and «what was sent was stale».
    hasSession: Boolean(entry.userId),
    userId: entry.userId ?? null,
    cookieCount: session?.cookieCount ?? null,
    rpcError: entry.rpcError ? { ...entry.rpcError } : null,
    // The rest of the picture.
    requestId: entry.requestId ?? null,
    userEmail: entry.userEmail ?? null,
    userRole: entry.userRole ?? null,
    /** The `sub` inside the cookie's own access token — present even when rejected. */
    sessionUserId: session?.session?.claims?.userId ?? null,
    rpc: entry.rpc ?? null,
    rpcArgs: entry.rpcArgs ?? null,
    cookieNames: session?.cookieNames ?? [],
    expectedAuthCookie: session?.expectedAuthCookie ?? null,
    hasExpectedAuthCookie: session?.hasExpectedAuthCookie ?? null,
    sessionCookie: session?.authCookie ?? null,
    claims: session?.session?.claims ?? null,
    refreshOnly: session?.session?.refreshOnly ?? null,
    projectRef: session?.projectRef ?? null,
    sessionNotes: session?.notes ?? [],
    note: entry.note ?? null,
  });
}

/**
 * The same line for the two gates that run before any RPC: «no session at all»
 * and «the staff gate refused this caller». Both are logged, because a page that
 * shows a database sentence while the logs stay empty is exactly what made this
 * bug expensive to find.
 */
export function logAdminAlertGateFailure(entry: {
  request: Request;
  route: string;
  action: string;
  /** Absent when `requireSupabaseUser()` itself rejected the request. */
  auth?: { userId: string; userEmail?: string | null; requestId: string; session: SessionReport | null } | null;
  /** From `requireOwnRole()` — `read_failed` means the database read failed. */
  reason: "auth_required" | "no_profile" | "inactive" | "forbidden" | "read_failed";
  /** The raw PostgREST error, when the profile read was what failed. */
  error?: PostgrestErrorLike | null;
}): void {
  logAdminAlertFailure({
    request: entry.request,
    route: entry.route,
    action: entry.action,
    reason: entry.reason === "auth_required" ? "auth_required" : "profile",
    requestId: entry.auth?.requestId ?? null,
    userId: entry.auth?.userId ?? null,
    userEmail: entry.auth?.userEmail ?? null,
    session: entry.auth?.session ?? null,
    rpc: entry.reason === "read_failed" ? "readOwnProfile" : null,
    rpcArgs: entry.reason === "read_failed" ? { table: "public.users" } : null,
    rpcError: entry.error ?? null,
    note: gateNote(entry.reason),
  });
}

/** Log-only sentence for a refused staff gate. */
function gateNote(reason: string): string {
  if (reason === "auth_required") return "no confirmed session for this request — see the [route-auth] session rejected line";
  if (reason === "read_failed") return "the profile read failed BEFORE any alert RPC ran — the page message is not about ofoq_admin_alerts";
  if (reason === "no_profile") return "the account has no public.users row (created before the profile trigger was installed?)";
  if (reason === "inactive") return "the profile is not ACTIVE";
  return "the role is not OWNER/PARTNER";
}

function safeDescribe(request: Request): SessionReport | null {
  try {
    return describeRequestSession(request);
  } catch {
    return null; // A log helper must never throw.
  }
}
