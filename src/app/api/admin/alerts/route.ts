import { logAdminAlertFailure, logAdminAlertGateFailure } from "@/lib/admin/alert-route-log";
import { getSupabaseConfig } from "@/lib/supabase/config";
import { jsonWithSession } from "@/lib/supabase/route-response";
import { requireOwnRole, requireSupabaseUser, rpcFailureResponse } from "@/lib/supabase/route-auth";
import type { AdminAlertFilter } from "@/lib/admin/alert-types";

export const dynamic = "force-dynamic";

const FILTERS: readonly AdminAlertFilter[] = ["OPEN", "ALL", "NEW", "ACKNOWLEDGED", "RESOLVED"];

const ROUTE = "GET /api/admin/alerts";

/**
 * GET /api/admin/alerts?status=OPEN&limit=50&offset=0
 *
 * Direct reads on public.alerts are deliberately revoked. The staff-only RPC
 * performs the role check and returns the list in one JSON payload instead.
 *
 * The session comes from this request's cookies, and a token refreshed during
 * the call is written back on the response (see requireSupabaseUser(request)).
 *
 * Every failure path writes exactly one `[admin-alerts]` line — including the
 * profile read before the RPC and a missing session, which used to leave the
 * page showing a database message with nothing to find in the logs. See
 * src/lib/admin/alert-route-log.ts.
 */
export async function GET(request: Request) {
  const auth = await requireSupabaseUser(request);
  if (auth.response) {
    logAdminAlertGateFailure({ request, route: ROUTE, action: "list", reason: "auth_required" });
    return auth.response;
  }

  const access = await requireOwnRole(auth.client, auth.user.id, ["OWNER", "PARTNER"], { requestId: auth.requestId });
  if (access.response) {
    logAdminAlertGateFailure({
      request,
      route: ROUTE,
      action: "list",
      auth: { userId: auth.user.id, userEmail: auth.user.email ?? null, requestId: auth.requestId, session: auth.session },
      reason: access.reason,
      error: access.error ?? null,
    });
    return access.response;
  }

  const url = new URL(request.url);
  const requestedFilter = url.searchParams.get("status")?.toUpperCase();
  const filter: AdminAlertFilter = FILTERS.includes(requestedFilter as AdminAlertFilter)
    ? requestedFilter as AdminAlertFilter
    : "ALL";
  const limit = clampInt(url.searchParams.get("limit"), 50, 1, 100);
  const offset = clampInt(url.searchParams.get("offset"), 0, 0, 10_000);
  const rpcArgs = { p_status: filter, p_limit: String(limit), p_offset: String(offset) };

  const { data, error } = await auth.client.rpc("ofoq_admin_alerts", {
    p_status: filter,
    p_limit: limit,
    p_offset: offset,
  });
  if (error) {
    const config = getSupabaseConfig();
    // One line, same shape as every other admin-alerts failure.
    logAdminAlertFailure({
      request,
      route: ROUTE,
      action: "list",
      reason: "rpc",
      requestId: auth.requestId,
      userId: auth.user.id,
      userEmail: auth.user.email ?? null,
      userRole: access.profile.role,
      session: auth.session,
      rpc: "ofoq_admin_alerts",
      rpcArgs,
      rpcError: error,
      note: `supabaseHost=${config ? hostOf(config.url) : "unconfigured"}`,
    });
    return rpcFailureResponse(error, {
      rpc: "ofoq_admin_alerts",
      args: rpcArgs,
      sessionProjectRef: auth.session?.projectRef.fromSession ?? null,
      configProjectRef: auth.session?.projectRef.fromConfigUrl ?? null,
      exposeHint: true,
      requestId: auth.requestId,
    });
  }

  return jsonWithSession(auth, { data });
}

function clampInt(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
