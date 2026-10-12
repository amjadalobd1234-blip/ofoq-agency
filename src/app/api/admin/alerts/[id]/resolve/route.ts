import {
  ALERT_ACTION_RPC,
  alertActionResponse,
  failAlertRequest,
  invalidActionResponse,
  invalidAlertIdResponse,
  isRecord,
  readAlertId,
  readText,
  requireStaffAccess,
} from "@/lib/admin/alert-route-guard";
import type { PostgrestErrorLike } from "@/lib/supabase/route-auth";

export const dynamic = "force-dynamic";

const ROUTE = "POST /api/admin/alerts/[id]/resolve";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/admin/alerts/:id/resolve — «تم الحل».
 *
 *   Body: { "note": "…" }   (optional, ≤ 2000 characters; `""` and `null` are
 *                            treated as «no note», exactly like the RPC)
 *
 * 200 → `{ data: <ofoq_admin_alert_details payload> }`, with `status` RESOLVED.
 * 400 → `{ error, code: "INVALID_RESOLUTION_NOTE" | "INVALID_ALERT_ID" }`
 *
 * `ofoq_admin_resolve_alert` is idempotent: resolving an alert that is already
 * RESOLVED returns the current state and writes no second activity row.
 *
 * The note is preserved in the append-only activity trail (never on the alert
 * row), which is why the page reads it back as `alert.resolutionNote`.
 */
export async function POST(request: Request, context: RouteContext) {
  const access = await requireStaffAccess(request, ROUTE, "resolve");
  if (access.response) return access.response;

  const alertId = await readAlertId(context);
  if (!alertId) return invalidAlertIdResponse();

  // A resolve with no body at all is valid: the note is optional.
  const payload = (await request.json().catch(() => ({}))) as unknown;
  if (payload !== null && payload !== undefined && !isRecord(payload)) {
    return invalidActionResponse("Send { note?: \"…\" } as JSON.", "INVALID_RESOLUTION_NOTE");
  }
  const note = readText(isRecord(payload) ? (payload.note ?? payload.p_note) : undefined, 2_000);
  if (note === undefined) {
    return invalidActionResponse("The resolution note is too long. It must be 2000 characters or fewer.", "INVALID_RESOLUTION_NOTE");
  }

  const { data, error } = await access.auth.client.rpc("ofoq_admin_resolve_alert", {
    p_alert_id: alertId,
    p_note: note || null,
  });

  if (error) {
    return failAlertRequest(error, {
      auth: access.auth,
      profile: access.profile,
      route: ROUTE,
      action: "resolve",
      rpc: ALERT_ACTION_RPC.resolve.rpc,
      alertId,
      args: { p_alert_id: "<alert id>", p_note: note ? `<note ${note.length} chars>` : "<empty>" },
      request,
    });
  }

  return alertActionResponse(access.auth, data);
}
