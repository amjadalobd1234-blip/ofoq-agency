import { ALERT_RPC_EXPECTATIONS, allAlertRpcsExposed, verifyAlertRpcs } from "@/lib/admin/alert-rpc-contract";
import { getSupabaseAuthStorageKey, getSupabaseConfig } from "@/lib/supabase/config";
import { fetchRestSurface } from "@/lib/supabase/postgrest-introspection";
import { diagnoseRpcFailure, newRequestId, type PostgrestErrorLike } from "@/lib/supabase/rpc-diagnostics";
import { jsonWithSession } from "@/lib/supabase/route-response";
import { fetchOwnProfile, requireSupabaseUser } from "@/lib/supabase/route-auth";
import { cookiesFromRequest, readAccessToken } from "@/lib/supabase/session-diagnostics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/debug/alerts — «why does /admin/alerts/[id] fail for THIS session?»
 *
 * Open it in the browser while signed in:
 *
 *   https://<site>/api/debug/alerts
 *   https://<site>/api/debug/alerts?alertId=<alerts.id>
 *
 * It answers, from the deployment itself:
 *
 *   1. did a session reach the route, which cookies arrived, is the session
 *      cookie the one this deployment reads, and — decisively — does the
 *      token's `ref` claim match the project in NEXT_PUBLIC_SUPABASE_URL?
 *   2. which of the five ofoq_admin_* RPCs does the Data API expose, and with
 *      exactly which parameter names (PostgREST's own OpenAPI document, read as
 *      the signed-in user)?
 *   3. does `ofoq_admin_alert_details` actually return data for a real alert of
 *      this project — with the raw PostgREST error when it does not.
 *
 * No secret leaves the process: cookie values and tokens are never included,
 * only names, sizes and the token's non-secret claims (project ref, role, exp).
 */
export async function GET(request: Request): Promise<Response> {
  const auth = await requireSupabaseUser(request);
  if (auth.response) return auth.response;

  const requestId = auth.requestId ?? newRequestId();
  const url = new URL(request.url);
  const config = getSupabaseConfig();
  const cookieName = config ? getSupabaseAuthStorageKey(config) : null;

  const profile = await fetchOwnProfile(auth.client, auth.user.id);
  const accessToken = config && cookieName ? readAccessToken(cookiesFromRequest(request), cookieName) : null;

  const surface = config
    ? await fetchRestSurface(config, accessToken)
    : { ok: false, status: null, serverVersion: null, rpcCount: 0, rpcs: new Map(), error: "Supabase is not configured in this deployment." };

  const rpcs = verifyAlertRpcs(surface.rpcs, surface.ok);
  const expectedSignatures = ALERT_RPC_EXPECTATIONS.map((expectation) => `${expectation.name}(${expectation.args.join(", ")})`);

  // A live probe with the caller's own JWT: the same call the staff page makes.
  const probe = await probeAlertDetails(auth, url.searchParams.get("alertId"), {
    sessionRef: auth.session?.projectRef.fromSession ?? null,
    configRef: auth.session?.projectRef.fromConfigUrl ?? null,
  });

  const ok = surface.ok && allAlertRpcsExposed(rpcs) && (!probe.attempted || probe.ok);

  console.log("[alerts-debug] GET /api/debug/alerts", {
    requestId,
    userId: auth.user.id,
    role: profile.profile?.role ?? null,
    restSurfaceOk: surface.ok,
    rpcCount: surface.rpcCount,
    rpcVerdicts: rpcs.map((verdict) => `${verdict.name}:${verdict.status}`),
    probeAlertId: probe.alertId,
    probeOk: probe.attempted ? probe.ok : null,
    probeCode: probe.error?.code ?? null,
  });

  return jsonWithSession(
    auth,
    {
      ok,
      requestId,
      generatedAt: new Date().toISOString(),
      session: {
        userId: auth.user.id,
        email: auth.user.email ?? null,
        profile: profile.profile
          ? { role: profile.profile.role, status: profile.profile.status }
          : { role: null, status: null, error: profile.error?.code ?? null },
        cookieCount: auth.session?.cookieCount ?? null,
        cookieNames: auth.session?.cookieNames ?? [],
        expectedAuthCookie: auth.session?.expectedAuthCookie ?? null,
        hasExpectedAuthCookie: auth.session?.hasExpectedAuthCookie ?? null,
        sessionCookie: auth.session?.authCookie ?? null,
        // Values are never included — these are the claims only.
        claims: auth.session?.session?.claims ?? null,
        refreshOnly: auth.session?.session?.refreshOnly ?? null,
        projectRef: auth.session?.projectRef ?? null,
        notes: auth.session?.notes ?? [],
      },
      dataApi: {
        host: config ? hostOf(config.url) : null,
        proxyConfigured: Boolean(config?.proxyUrl),
        openapiReadable: surface.ok,
        status: surface.status,
        server: surface.serverVersion,
        rpcCount: surface.rpcCount,
        error: surface.error,
      },
      expectedSignatures,
      rpcs,
      probe,
      nextSteps: buildNextSteps(rpcs, surface.ok, probe, auth.session?.notes ?? []),
      sql: {
        signatures: [
          "SELECT p.oid::regprocedure AS signature, pg_get_function_arguments(p.oid) AS args,",
          "       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_can_execute",
          "FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace",
          "WHERE n.nspname = 'public'",
          `  AND p.proname IN (${ALERT_RPC_EXPECTATIONS.map((expectation) => `'${expectation.name}'`).join(", ")})`,
          "ORDER BY 1;",
        ].join("\n"),
        reloadSchema: "NOTIFY pgrst, 'reload schema';",
      },
    },
    { status: ok ? 200 : 503 },
  );
}

async function probeAlertDetails(
  auth: Awaited<ReturnType<typeof requireSupabaseUser>>,
  requestedId: string | null,
  projectRefs: { sessionRef: string | null; configRef: string | null },
): Promise<{
  attempted: boolean;
  ok: boolean;
  alertId: string | null;
  persona: string | null;
  error: PostgrestErrorLike | null;
  diagnosis: { kind: string; code: string; explanation: string; hint: string } | null;
  returnedAlertKeys: string[] | null;
}> {
  if (!("client" in auth) || !auth.client) {
    return { attempted: false, ok: false, alertId: null, persona: null, error: null, diagnosis: null, returnedAlertKeys: null };
  }

  let alertId = requestedId?.trim() || null;
  if (!alertId) {
    // Any real alert of this project: the list RPC doubles as «is the inbox
    // readable at all?». A failure here is reported as the probe error.
    const listed = await auth.client.rpc("ofoq_admin_alerts", { p_status: "ALL", p_limit: 1, p_offset: 0 });
    if (listed.error) {
      const diagnosis = diagnoseRpcFailure(listed.error, { rpc: "ofoq_admin_alerts", args: { p_status: "ALL", p_limit: "1", p_offset: "0" }, ...projectRefs });
      return {
        attempted: true,
        ok: false,
        alertId: null,
        persona: null,
        error: listed.error,
        diagnosis: { kind: diagnosis.kind, code: diagnosis.code, explanation: diagnosis.explanation, hint: diagnosis.hint },
        returnedAlertKeys: null,
      };
    }
    const items = (listed.data as { items?: Array<{ id?: unknown }> } | null)?.items;
    const first = Array.isArray(items) ? items.find((item) => typeof item?.id === "string") : null;
    alertId = first && typeof first.id === "string" ? first.id : null;
    if (!alertId) {
      return {
        attempted: true,
        ok: false,
        alertId: null,
        persona: null,
        error: null,
        diagnosis: {
          kind: "not_found",
          code: "NO_ALERT_TO_PROBE",
          explanation: "ofoq_admin_alerts returned an empty page, so there is no alert id to test the details RPC with.",
          hint: "Raise one escalation from /chat (or pass ?alertId=<uuid> explicitly), then reload this report.",
        },
        returnedAlertKeys: null,
      };
    }
  }

  const { data, error } = await auth.client.rpc("ofoq_admin_alert_details", { p_alert_id: alertId });
  if (error) {
    const diagnosis = diagnoseRpcFailure(error, { rpc: "ofoq_admin_alert_details", args: { p_alert_id: "<alert id>" }, ...projectRefs });
    return {
      attempted: true,
      ok: false,
      alertId,
      persona: null,
      error,
      diagnosis: { kind: diagnosis.kind, code: diagnosis.code, explanation: diagnosis.explanation, hint: diagnosis.hint },
      returnedAlertKeys: null,
    };
  }

  return {
    attempted: true,
    ok: true,
    alertId,
    persona: typeof (data as { alert?: { targetRole?: unknown } } | null)?.alert?.targetRole === "string"
      ? ((data as { alert: { targetRole: string } }).alert.targetRole)
      : null,
    error: null,
    diagnosis: null,
    returnedAlertKeys: data && typeof data === "object" ? Object.keys(data as Record<string, unknown>) : null,
  };
}

function buildNextSteps(
  rpcs: ReturnType<typeof verifyAlertRpcs>,
  surfaceOk: boolean,
  probe: { attempted: boolean; ok: boolean; diagnosis: { hint: string } | null },
  sessionNotes: string[],
): string[] {
  const steps: string[] = [];
  if (!surfaceOk) {
    steps.push("The Data API's OpenAPI document could not be read: check NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY, then redeploy (NEXT_PUBLIC_* values are inlined at build time).");
  }
  for (const verdict of rpcs) {
    if (verdict.status === "missing") steps.push(`${verdict.name}: ${verdict.detail.en}`);
    if (verdict.status === "signature_mismatch") {
      steps.push(`${verdict.name}: installed as (${verdict.installedArgs.join(", ") || "no arguments"}) but the app calls it with (${verdict.expectedArgs.join(", ")}) — drop the old overload and re-apply the migration.`);
    }
  }
  if (sessionNotes.length > 0) steps.push(...sessionNotes);
  if (probe.attempted && probe.diagnosis) steps.push(probe.diagnosis.hint);
  if (steps.length === 0) steps.push("Nothing to fix: the session, the project and all five alert RPCs agree.");
  return steps;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
