import {
  ALERT_ACTION_RPC,
  alertActionResponse,
  failAlertRequest,
  invalidActionResponse,
  invalidAlertIdResponse,
  isRecord,
  readAlertId,
  readFirstText,
  readLanguage,
  requireStaffAccess,
} from "@/lib/admin/alert-route-guard";
import type { PostgrestErrorLike } from "@/lib/supabase/route-auth";

export const dynamic = "force-dynamic";

const ROUTE = "POST /api/admin/alerts/[id]/reply";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/admin/alerts/:id/reply — send the team's reply to the client.
 *
 *   Body: { "body": "…", "language": "ar" | "en" }        (the documented form)
 *         { "message": "…" } / { "text": "…" }            (accepted aliases)
 *         { "p_body": "…", "p_language": "ar" }           (the RPC's own names)
 *
 * 200 → `{ data: <ofoq_admin_alert_details payload> }` (the alert with the new
 *       STAFF message and the refreshed activity trail).
 * 400 → `{ error, code: "INVALID_REPLY_BODY" | "INVALID_ALERT_ID" }`
 * 401 → no usable session; 403 → not OWNER/PARTNER; 503 → the RPC is not
 *       exposed to the Data API (see GET /api/debug/alerts for the diff).
 *
 * The write itself happens inside `ofoq_admin_reply_to_client` (SECURITY
 * DEFINER): it inserts one `public.messages` row with `sender_type = 'STAFF'`,
 * binds it to `auth.uid()`, bumps the conversation counters, acknowledges a NEW
 * alert and appends an `alert.replied_to_client` activity. The browser never
 * touches those tables — every privilege on them is revoked from `authenticated`.
 *
 * Why this route exists on its own
 * --------------------------------
 * One endpoint per button makes «did the click reach the server?» answerable
 * from the host's logs: the route label, the RPC name and the argument names are
 * logged together on every failure, so a renamed parameter shows up as PGRST202
 * on `ofoq_admin_reply_to_client(p_alert_id, p_body, p_language)` instead of as
 * a button that appears to do nothing.
 */
export async function POST(request: Request, context: RouteContext) {
  const access = await requireStaffAccess(request, ROUTE, "reply");
  if (access.response) return access.response;

  const alertId = await readAlertId(context);
  if (!alertId) return invalidAlertIdResponse();

  const payload = await request.json().catch(() => null);
  if (!isRecord(payload)) {
    return invalidActionResponse("Send { body: \"…\", language?: \"ar\" | \"en\" } as JSON.", "INVALID_REPLY_BODY");
  }

  // Trims, rejects a non-string, and bounds it exactly like the RPC does.
  const body = readFirstText(payload, ["body", "message", "text", "p_body"], 5_000);
  if (!body) {
    return invalidActionResponse("Write the reply before sending it. It must contain between 1 and 5000 characters.", "INVALID_REPLY_BODY");
  }
  const language = readLanguage(payload.language ?? payload.p_language);

  const { data, error } = await access.auth.client.rpc("ofoq_admin_reply_to_client", {
    p_alert_id: alertId,
    p_body: body,
    p_language: language,
  });

  if (error) {
    return failAlertRequest(error, {
      auth: access.auth,
      profile: access.profile,
      route: ROUTE,
      action: "reply",
      rpc: ALERT_ACTION_RPC.reply.rpc,
      alertId,
      args: { p_alert_id: "<alert id>", p_body: `<reply ${body.length} chars>`, p_language: language },
      request,
    });
  }

  // The RPC answers with the full alert payload; the page re-renders from it,
  // which is what makes the new message appear without a reload.
  return alertActionResponse(access.auth, data);
}
