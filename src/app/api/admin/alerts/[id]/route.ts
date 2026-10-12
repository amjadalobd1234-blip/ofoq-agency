import {
  ALERT_ACTION_RPC,
  failAlertRequest,
  invalidActionResponse,
  invalidAlertIdResponse,
  isRecord,
  readAlertId,
  readLanguage,
  readText,
  requireStaffAccess,
} from "@/lib/admin/alert-route-guard";
import { jsonWithSession } from "@/lib/supabase/route-response";
import type { PostgrestErrorLike } from "@/lib/supabase/route-auth";

export const dynamic = "force-dynamic";

const ROUTE = "GET /api/admin/alerts/[id]";
const ACTION_ROUTE = "POST /api/admin/alerts/[id]";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/admin/alerts/:id — the complete alert, client and conversation context.
 *
 * The session is read from THIS request (see `requireSupabaseUser(request)`), so
 * a token the SDK refreshes mid-request is written back onto the response
 * instead of being lost. Every failure — a missing session, the profile read
 * and the RPC itself — writes one `[admin-alerts]` line with `hasSession`,
 * `userId`, `cookieCount` and `rpcError`. See src/lib/admin/alert-route-log.ts
 * and docs/ADMIN-ALERTS-AR.md.
 */
export async function GET(request: Request, context: RouteContext) {
  const access = await requireStaffAccess(request, ROUTE, "details");
  if (access.response) return access.response;

  const alertId = await readAlertId(context);
  if (!alertId) return invalidAlertIdResponse();

  const { data, error } = await access.auth.client.rpc("ofoq_admin_alert_details", { p_alert_id: alertId });
  if (error) {
    return failAlertRequest(error, {
      auth: access.auth,
      profile: access.profile,
      route: ROUTE,
      action: "details",
      rpc: "ofoq_admin_alert_details",
      alertId,
      args: { p_alert_id: "<alert id>" },
      request,
    });
  }

  return jsonWithSession(access.auth, { data });
}

/**
 * POST /api/admin/alerts/:id
 *
 * The original one-endpoint form of every action:
 *
 *   { "action": "acknowledge" }
 *   { "action": "resolve",  "note": "…" }
 *   { "action": "reply",    "body": "…", "language": "ar" | "en" }
 *
 * The dedicated routes (`…/[id]/reply`, `…/[id]/resolve`) are the ones the staff
 * page now calls, but this stays supported so a browser tab that loaded the old
 * bundle keeps working after a deploy. All three run the same guard, the same
 * RPCs and the same logging.
 *
 * The browser never writes alerts/messages directly. Every action is sent to a
 * narrowly scoped SECURITY DEFINER RPC that records the responsible staff user.
 */
export async function POST(request: Request, context: RouteContext) {
  const access = await requireStaffAccess(request, ACTION_ROUTE, "action");
  if (access.response) return access.response;

  const alertId = await readAlertId(context);
  if (!alertId) return invalidAlertIdResponse();

  const payload = await request.json().catch(() => null);
  if (!isRecord(payload) || !isAction(payload.action)) {
    return invalidActionResponse(
      "The alert action is invalid. Send { action: \"acknowledge\" } | { action: \"resolve\", note? } | { action: \"reply\", body, language? }.",
      "INVALID_ACTION",
    );
  }

  let data: unknown;
  let error: PostgrestErrorLike | null;
  let rpc: string;
  let args: Record<string, string> = { p_alert_id: "<alert id>" };

  if (payload.action === "acknowledge") {
    rpc = ALERT_ACTION_RPC.acknowledge.rpc;
    ({ data, error } = await access.auth.client.rpc("ofoq_admin_acknowledge_alert", { p_alert_id: alertId }));
  } else if (payload.action === "resolve") {
    const note = readText(payload.note, 2_000);
    if (note === undefined) {
      return invalidActionResponse("The resolution note is too long. It must be 2000 characters or fewer.", "INVALID_RESOLUTION_NOTE");
    }
    rpc = ALERT_ACTION_RPC.resolve.rpc;
    args = { p_alert_id: "<alert id>", p_note: note ? `<note ${note.length} chars>` : "<empty>" };
    ({ data, error } = await access.auth.client.rpc("ofoq_admin_resolve_alert", {
      p_alert_id: alertId,
      p_note: note || null,
    }));
  } else {
    const body = readText(payload.body, 5_000);
    const language = readLanguage(payload.language);
    if (!body) {
      return invalidActionResponse("Write the reply before sending it. It must contain between 1 and 5000 characters.", "INVALID_REPLY_BODY");
    }
    rpc = ALERT_ACTION_RPC.reply.rpc;
    args = { p_alert_id: "<alert id>", p_body: `<reply ${body.length} chars>`, p_language: language };
    ({ data, error } = await access.auth.client.rpc("ofoq_admin_reply_to_client", {
      p_alert_id: alertId,
      p_body: body,
      p_language: language,
    }));
  }

  if (error) {
    return failAlertRequest(error, {
      auth: access.auth,
      profile: access.profile,
      route: ACTION_ROUTE,
      action: payload.action,
      rpc,
      alertId,
      args,
      request,
    });
  }
  return jsonWithSession(access.auth, { data });
}

function isAction(value: unknown): value is "acknowledge" | "resolve" | "reply" {
  return value === "acknowledge" || value === "resolve" || value === "reply";
}
