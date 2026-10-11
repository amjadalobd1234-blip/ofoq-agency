import { getSupabaseConfig } from "@/lib/supabase/config";
import { jsonWithSession } from "@/lib/supabase/route-response";
import {
  requireOwnRole,
  requireSupabaseUser,
  rpcFailureResponse,
  type PostgrestErrorLike,
  type SupabaseProfile,
  type SupabaseSessionAuth,
} from "@/lib/supabase/route-auth";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };
type AlertAction = "acknowledge" | "resolve" | "reply";

/**
 * GET /api/admin/alerts/:id — the complete alert, client and conversation context.
 *
 * The session is read from THIS request (see `requireSupabaseUser(request)`), so
 * a token the SDK refreshes mid-request is written back onto the response
 * instead of being lost. Every failure is logged with the cookie names, the
 * session's project reference and the full PostgREST error — see
 * `failAlertRequest()` and docs/ADMIN-ALERTS-AR.md.
 */
export async function GET(request: Request, context: RouteContext) {
  const access = await requireStaff(request);
  if (access.response) return access.response;

  const alertId = await getAlertId(context);
  if (!alertId) return invalidRequestResponse();

  const { data, error } = await access.auth.client.rpc("ofoq_admin_alert_details", { p_alert_id: alertId });
  if (error) {
    return failAlertRequest(error, {
      auth: access.auth,
      profile: access.profile,
      action: "details",
      rpc: "ofoq_admin_alert_details",
      alertId,
      args: { p_alert_id: "<alert id>" },
    });
  }

  return jsonWithSession(access.auth, { data });
}

/**
 * POST /api/admin/alerts/:id
 *
 * The browser never writes alerts/messages directly. Every action is sent to a
 * narrowly scoped SECURITY DEFINER RPC that records the responsible staff user.
 */
export async function POST(request: Request, context: RouteContext) {
  const access = await requireStaff(request);
  if (access.response) return access.response;

  const alertId = await getAlertId(context);
  if (!alertId) return invalidRequestResponse();

  const payload = await request.json().catch(() => null);
  if (!isRecord(payload) || !isAction(payload.action)) return invalidRequestResponse();

  let data: unknown;
  let error: PostgrestErrorLike | null;
  let rpc: string;
  let args: Record<string, string> = { p_alert_id: "<alert id>" };

  if (payload.action === "acknowledge") {
    rpc = "ofoq_admin_acknowledge_alert";
    ({ data, error } = await access.auth.client.rpc("ofoq_admin_acknowledge_alert", { p_alert_id: alertId }));
  } else if (payload.action === "resolve") {
    const note = readText(payload.note, 2_000);
    if (note === undefined) return invalidRequestResponse();
    rpc = "ofoq_admin_resolve_alert";
    args = { p_alert_id: "<alert id>", p_note: note ? `<note ${note.length} chars>` : "<empty>" };
    ({ data, error } = await access.auth.client.rpc("ofoq_admin_resolve_alert", {
      p_alert_id: alertId,
      p_note: note || null,
    }));
  } else {
    const body = readText(payload.body, 5_000);
    const language = payload.language === "en" ? "en" : "ar";
    if (!body) return invalidRequestResponse();
    rpc = "ofoq_admin_reply_to_client";
    args = { p_alert_id: "<alert id>", p_body: `<reply ${body.length} chars>`, p_language: language };
    ({ data, error } = await access.auth.client.rpc("ofoq_admin_reply_to_client", {
      p_alert_id: alertId,
      p_body: body,
      p_language: language,
    }));
  }

  if (error) {
    return failAlertRequest(error, { auth: access.auth, profile: access.profile, action: payload.action, rpc, alertId, args });
  }
  return jsonWithSession(access.auth, { data });
}

interface StaffAccess {
  auth: SupabaseSessionAuth;
  profile: SupabaseProfile;
}

async function requireStaff(
  request: Request,
): Promise<(StaffAccess & { response?: never }) | { auth?: never; profile?: never; response: Response }> {
  const auth = await requireSupabaseUser(request);
  if (auth.response) return { response: auth.response };

  const role = await requireOwnRole(auth.client, auth.user.id, ["OWNER", "PARTNER"]);
  if (role.response) return { response: role.response };

  return { auth, profile: role.profile };
}

async function getAlertId(context: RouteContext): Promise<string | null> {
  const { id } = await context.params;
  const value = id?.trim();
  return value && value.length <= 200 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAction(value: unknown): value is AlertAction {
  return value === "acknowledge" || value === "resolve" || value === "reply";
}

/** Returns a trimmed string or undefined when it is not valid user input. */
function readText(value: unknown, maxLength: number): string | undefined {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length <= maxLength ? trimmed : undefined;
}

function invalidRequestResponse(): Response {
  return Response.json(
    { error: "The alert action is invalid.", code: "INVALID_INPUT" },
    { status: 400, headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * One line that answers, without another deploy, «why did this staff action
 * fail?»:
 *
 * - `session`            → which cookies arrived, whether the expected session
 *                          cookie was there, what project the token is for,
 *                          and whether that matches NEXT_PUBLIC_SUPABASE_URL
 * - `rpcError`           → the complete PostgREST error (code/message/details/hint)
 * - `explanation/nextStep` (from rpcFailureResponse) → the classified cause and
 *                          the exact SQL or setting to change
 *
 * Never logged: cookie values, tokens, message bodies or row data.
 */
function failAlertRequest(
  error: PostgrestErrorLike,
  context: {
    auth: SupabaseSessionAuth;
    profile: SupabaseProfile;
    action: string;
    rpc: string;
    alertId: string;
    /** Argument NAMES with placeholders — never the message text of a note or reply. */
    args: Record<string, string>;
  },
): Response {
  const { auth, profile } = context;
  const config = getSupabaseConfig();
  // eslint-disable-next-line no-console
  console.error(`[api/admin/alerts] ${context.action} RPC failed`, {
    requestId: auth.requestId,
    action: context.action,
    alertId: context.alertId,
    rpc: context.rpc,
    rpcArgs: context.args,
    userId: auth.user.id,
    userEmail: auth.user.email,
    userRole: profile.role,
    userStatus: profile.status,
    supabaseHost: config ? safeHost(config.url) : null,
    session: auth.session,
    rpcError: {
      code: error.code ?? null,
      message: error.message ?? null,
      details: error.details ?? null,
      hint: error.hint ?? null,
    },
  });

  return rpcFailureResponse(error, {
    rpc: context.rpc,
    args: context.args,
    sessionProjectRef: auth.session?.projectRef.fromSession ?? null,
    configProjectRef: auth.session?.projectRef.fromConfigUrl ?? null,
    exposeHint: true,
    requestId: auth.requestId,
  });
}

/** Host only — the URL carries no secret, but the log needs one token, not a sentence. */
function safeHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
