import { requireOwnRole, requireSupabaseUser, rpcFailureResponse } from "@/lib/supabase/route-auth";
import type { AdminAlertFilter } from "@/lib/admin/alert-types";

export const dynamic = "force-dynamic";

const FILTERS: readonly AdminAlertFilter[] = ["OPEN", "ALL", "NEW", "ACKNOWLEDGED", "RESOLVED"];

/**
 * GET /api/admin/alerts?status=OPEN&limit=50&offset=0
 *
 * Direct reads on public.alerts are deliberately revoked. The staff-only RPC
 * performs the role check and returns the list in one JSON payload instead.
 */
export async function GET(request: Request) {
  const auth = await requireSupabaseUser();
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
    // eslint-disable-next-line no-console
    console.error("[api/admin/alerts] ofoq_admin_alerts RPC failed:", {
      code: error.code,
      message: error.message,
      userId: auth.user.id,
    });
    return rpcFailureResponse(error);
  }

  return Response.json({ data }, { headers: { "Cache-Control": "no-store, max-age=0" } });
}

function clampInt(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
