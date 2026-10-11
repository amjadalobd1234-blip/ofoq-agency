import { getSupabaseConfig } from "@/lib/supabase/config";
import { jsonWithSession } from "@/lib/supabase/route-response";
import { requireOwnRole, requireSupabaseUser, rpcFailureResponse } from "@/lib/supabase/route-auth";
import type { AdminAlertFilter } from "@/lib/admin/alert-types";

export const dynamic = "force-dynamic";

const FILTERS: readonly AdminAlertFilter[] = ["OPEN", "ALL", "NEW", "ACKNOWLEDGED", "RESOLVED"];

/**
 * GET /api/admin/alerts?status=OPEN&limit=50&offset=0
 *
 * Direct reads on public.alerts are deliberately revoked. The staff-only RPC
 * performs the role check and returns the list in one JSON payload instead.
 *
 * The session comes from this request's cookies, and a token refreshed during
 * the call is written back on the response (see requireSupabaseUser(request)).
 */
export async function GET(request: Request) {
  const auth = await requireSupabaseUser(request);
  if (auth.response) return auth.response;

  const access = await requireOwnRole(auth.client, auth.user.id, ["OWNER", "PARTNER"]);
  if (access.response) return access.response;

  const url = new URL(request.url);
  const requestedFilter = url.searchParams.get("status")?.toUpperCase();
  const filter: AdminAlertFilter = FILTERS.includes(requestedFilter as AdminAlertFilter)
    ? requestedFilter as AdminAlertFilter
    : "ALL";
  const limit = clampInt(url.searchParams.get("limit"), 50, 1, 100);
  const offset = clampInt(url.searchParams.get("offset"), 0, 0, 10_000);

  const { data, error } = await auth.client.rpc("ofoq_admin_alerts", {
    p_status: filter,
    p_limit: limit,
    p_offset: offset,
  });
  if (error) {
    const config = getSupabaseConfig();
    // eslint-disable-next-line no-console
    console.error("[api/admin/alerts] ofoq_admin_alerts RPC failed:", {
      requestId: auth.requestId,
      userId: auth.user.id,
      userEmail: auth.user.email,
      userRole: access.profile.role,
      supabaseHost: config ? hostOf(config.url) : null,
      filter,
      limit,
      offset,
      session: auth.session,
      rpcError: {
        code: error.code ?? null,
        message: error.message ?? null,
        details: error.details ?? null,
        hint: error.hint ?? null,
      },
    });
    return rpcFailureResponse(error, {
      rpc: "ofoq_admin_alerts",
      args: { p_status: filter, p_limit: String(limit), p_offset: String(offset) },
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
