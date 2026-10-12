/**
 * The staff gate and the failure logging shared by every alert action route.
 *
 * Why this module exists
 * ----------------------
 * /admin/alerts/[id] used to be the only place that could run an alert action:
 * one POST with `{ action: "acknowledge" | "resolve" | "reply" }`. The dedicated
 * routes (`…/[id]/reply`, `…/[id]/resolve`) were added afterwards, and a second
 * copy of the gate would be a second place to fix a log line or a status code —
 * which is exactly how «the button does nothing» bugs survive.
 *
 * So the rules live here, once:
 *
 *   1. `requireStaffAccess()` — a session must reach the route, and the caller's
 *      own `public.users` row must be OWNER/PARTNER. Both refusals are logged in
 *      the `[admin-alerts]` shape the host's logs are filtered on.
 *   2. `readAlertId()` — the id comes from the path, bounded like the RPCs bound
 *      it, so a bad id is a 400 instead of a 404 from PostgreSQL.
 *   3. `failAlertRequest()` — the RPC error is logged with the argument NAMES
 *      (never a reply body) plus the session facts needed to tell «not
 *      installed» from «wrong project» from «not staff».
 *   4. `invalidActionResponse()` — one 400 shape with a machine code, so the UI
 *      can say which field was wrong instead of «the action is invalid».
 */
import { logAdminAlertFailure, logAdminAlertGateFailure } from "./alert-route-log";
import { getSupabaseConfig } from "@/lib/supabase/config";
import { jsonWithSession } from "@/lib/supabase/route-response";
import {
  requireOwnRole,
  requireSupabaseUser,
  rpcFailureResponse,
  type PostgrestErrorLike,
  type ProfileFailureReason,
  type SupabaseProfile,
  type SupabaseSessionAuth,
} from "@/lib/supabase/route-auth";

/** The staff roles allowed to run an alert action. */
export const ALERT_STAFF_ROLES = ["OWNER", "PARTNER"] as const;

/** RPC name plus the argument names each action sends — the PostgREST contract. */
export const ALERT_ACTION_RPC = {
  acknowledge: { rpc: "ofoq_admin_acknowledge_alert", args: ["p_alert_id"] },
  resolve: { rpc: "ofoq_admin_resolve_alert", args: ["p_alert_id", "p_note"] },
  reply: { rpc: "ofoq_admin_reply_to_client", args: ["p_alert_id", "p_body", "p_language"] },
} as const;

export type AlertAction = keyof typeof ALERT_ACTION_RPC;

export interface AlertStaffAccess {
  auth: SupabaseSessionAuth;
  profile: SupabaseProfile;
  response?: never;
}

export type AlertAccessResult = AlertStaffAccess | { auth?: never; profile?: never; response: Response };

/**
 * The gate in front of every alert action.
 *
 * `route` is the log's route label (e.g. `POST /api/admin/alerts/[id]/reply`)
 * and `action` the UI action it serves — together they answer «which button did
 * this?» in the host's function logs.
 */
export async function requireStaffAccess(request: Request, route: string, action: string): Promise<AlertAccessResult> {
  const auth = await requireSupabaseUser(request);
  if (auth.response) {
    logAdminAlertGateFailure({ request, route, action, reason: "auth_required" });
    return { response: auth.response };
  }

  const role = await requireOwnRole(auth.client, auth.user.id, [...ALERT_STAFF_ROLES], { requestId: auth.requestId });
  if (role.response) {
    logAdminAlertGateFailure({
      request,
      route,
      action,
      auth: { userId: auth.user.id, userEmail: auth.user.email ?? null, requestId: auth.requestId, session: auth.session },
      reason: role.reason as ProfileFailureReason,
      error: role.error ?? null,
    });
    return { response: role.response };
  }

  return { auth, profile: role.profile };
}

/** The alert id from the route params, or null when it cannot be a real id. */
export async function readAlertId(context: { params: Promise<{ id: string }> }): Promise<string | null> {
  const { id } = await context.params;
  const value = id?.trim();
  return value && value.length <= 200 ? value : null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Returns a trimmed string, `""` for an absent value, or `undefined` when the
 * value is not usable text (a number, an array, or longer than `maxLength`).
 */
export function readText(value: unknown, maxLength: number): string | undefined {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length <= maxLength ? trimmed : undefined;
}

/**
 * The first non-empty string among the names a client may use.
 *
 * The dedicated reply endpoint documents `{ body }`, but the field has been
 * called `body`, `message` and `text` in different callers over time; accepting
 * all three keeps a stale browser bundle working instead of answering a 400 the
 * user experiences as «the button does nothing».
 */
export function readFirstText(payload: Record<string, unknown>, names: readonly string[], maxLength: number): string | undefined {
  for (const name of names) {
    if (!(name in payload)) continue;
    const value = readText(payload[name], maxLength);
    if (value === undefined) return undefined;
    if (value) return value;
  }
  return "";
}

/** `ar` or `en` — anything else is the default, exactly like the SQL does. */
export function readLanguage(value: unknown): "ar" | "en" {
  return value === "en" ? "en" : "ar";
}

/** A 400 whose machine code says WHICH field was wrong. */
export function invalidActionResponse(message: string, code: string): Response {
  return Response.json({ error: message, code }, { status: 400, headers: { "Cache-Control": "no-store" } });
}

/** The alert id was missing or malformed in the URL. */
export function invalidAlertIdResponse(): Response {
  return invalidActionResponse("The alert id is invalid.", "INVALID_ALERT_ID");
}

export interface AlertRpcFailureContext {
  auth: SupabaseSessionAuth;
  profile: SupabaseProfile;
  /** The log's route label. */
  route: string;
  action: string;
  rpc: string;
  alertId: string;
  /** Argument NAMES with placeholders — never the text of a note or a reply. */
  args: Record<string, string>;
  /** The incoming request, so the log reports the session it carried. */
  request: Request;
  /** Set when the RPC ran but returned an unusable payload. */
  note?: string;
}

/**
 * One failing alert action, in one place: the `[admin-alerts]` log line, the
 * second `[rpc] … failed` classification line, and the browser response.
 *
 * Never logged: cookie values, tokens, message bodies or row data.
 */
export function failAlertRequest(error: PostgrestErrorLike, context: AlertRpcFailureContext): Response {
  const { auth, profile } = context;
  const config = getSupabaseConfig();
  logAdminAlertFailure({
    request: context.request,
    route: context.route,
    action: context.action,
    reason: "rpc",
    requestId: auth.requestId,
    userId: auth.user.id,
    userEmail: auth.user.email ?? null,
    userRole: profile.role,
    session: auth.session,
    rpc: context.rpc,
    rpcArgs: { ...context.args, alertId: context.alertId },
    rpcError: error,
    note: context.note ? `${context.note} supabaseHost=${config ? safeHost(config.url) : "unconfigured"}` : `supabaseHost=${config ? safeHost(config.url) : "unconfigured"}`,
  });
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

/** The success path shared by every action: JSON plus any refreshed session cookie. */
export function alertActionResponse(auth: SupabaseSessionAuth, data: unknown): Response {
  return jsonWithSession(auth, { data });
}

/** Host only — the URL carries no secret, but the log needs one token, not a sentence. */
export function safeHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
