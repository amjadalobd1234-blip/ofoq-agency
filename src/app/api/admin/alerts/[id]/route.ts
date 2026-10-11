import { requireOwnRole, requireSupabaseUser, rpcFailureResponse } from "@/lib/supabase/route-auth";
import type { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };
type AlertAction = "acknowledge" | "resolve" | "reply";
type ServerClient = NonNullable<Awaited<ReturnType<typeof createSupabaseServerClient>>>;

/** GET /api/admin/alerts/:id — the complete alert, client and conversation context. */
export async function GET(_request: Request, context: RouteContext) {
  const access = await requireStaff();
  if (access.response) return access.response;

  const alertId = await getAlertId(context);
  if (!alertId) return invalidRequestResponse();

  const { data, error } = await access.client.rpc("ofoq_admin_alert_details", { p_alert_id: alertId });
  if (error) return logAndRespond(error, "details", access.userId);

  return Response.json({ data }, { headers: { "Cache-Control": "no-store, max-age=0" } });
}

/**
 * POST /api/admin/alerts/:id
 *
 * The browser never writes alerts/messages directly. Every action is sent to a
 * narrowly scoped SECURITY DEFINER RPC that records the responsible staff user.
 */
export async function POST(request: Request, context: RouteContext) {
  const access = await requireStaff();
  if (access.response) return access.response;

  const alertId = await getAlertId(context);
  if (!alertId) return invalidRequestResponse();

  const payload = await request.json().catch(() => null);
  if (!isRecord(payload) || !isAction(payload.action)) return invalidRequestResponse();

  let data: unknown;
  let error: { code?: string; message?: string } | null;

  if (payload.action === "acknowledge") {
    ({ data, error } = await access.client.rpc("ofoq_admin_acknowledge_alert", { p_alert_id: alertId }));
  } else if (payload.action === "resolve") {
    const note = readText(payload.note, 2_000);
    if (note === undefined) return invalidRequestResponse();
    ({ data, error } = await access.client.rpc("ofoq_admin_resolve_alert", {
      p_alert_id: alertId,
      p_note: note || null,
    }));
  } else {
    const body = readText(payload.body, 5_000);
    const language = payload.language === "en" ? "en" : "ar";
    if (!body) return invalidRequestResponse();
    ({ data, error } = await access.client.rpc("ofoq_admin_reply_to_client", {
      p_alert_id: alertId,
      p_body: body,
      p_language: language,
    }));
  }

  if (error) return logAndRespond(error, payload.action, access.userId);
  return Response.json({ data }, { headers: { "Cache-Control": "no-store, max-age=0" } });
}

async function requireStaff(): Promise<
  | { client: ServerClient; userId: string; response?: never }
  | { client?: never; userId?: never; response: Response }
> {
  const auth = await requireSupabaseUser();
  if (auth.response) return { response: auth.response };

  const role = await requireOwnRole(auth.client, auth.user.id, ["OWNER", "PARTNER"]);
  if (role.response) return { response: role.response };

  return { client: auth.client, userId: auth.user.id };
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
    { error: "The alert action is invalid." },
    { status: 400, headers: { "Cache-Control": "no-store" } },
  );
}

function logAndRespond(error: { code?: string; message?: string }, action: string, userId: string): Response {
  // PostgreSQL details stay server-side, but have enough context for support.
  // eslint-disable-next-line no-console
  console.error(`[api/admin/alerts] ${action} RPC failed:`, { code: error.code, message: error.message, userId });
  return rpcFailureResponse(error);
}
