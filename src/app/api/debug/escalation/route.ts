import { fetchEscalationDiagnostics, probeAlertInsert } from "@/lib/services/escalation.service";
import { requireSupabaseUser } from "@/lib/supabase/route-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/debug/escalation — why did the human handoff fail for THIS account?
 *
 * The chat route already logs every failed escalation with the caller's id,
 * role and client record. This endpoint answers the same question on demand,
 * from the database itself, so it can be opened in a browser while signed in:
 *
 *   https://<site>/api/debug/escalation
 *   https://<site>/api/debug/escalation?conversationId=<id>
 *   https://<site>/api/debug/escalation?insertTest=1
 *
 * It reports the caller's platform profile and client record, who owns the web
 * conversation, whether `public.alerts` exists (and whether `customer_id` is
 * still nullable), whether the `ofoq_client_escalate` RPC is installed, and who
 * would be notified. By default nothing is written.
 *
 * `insertTest=1` is the one exception and is opt-in: it INSERTs a labelled probe
 * row into `public.alerts` with the caller's own session, then DELETEs it. The
 * response reports both steps; if the INSERT is refused, the full database
 * error is returned so the cause is visible. A failed DELETE is reported with
 * the probe id so the row can be removed by hand.
 *
 * A structured version of the same report is also shown in section 8 of /debug.
 */
export async function GET(request: Request): Promise<Response> {
  const auth = await requireSupabaseUser();
  if (auth.response) return auth.response;

  const url = new URL(request.url);
  const conversationId = url.searchParams.get("conversationId");
  const insertTest = ["1", "true"].includes((url.searchParams.get("insertTest") ?? "").toLowerCase());

  const report = await fetchEscalationDiagnostics(auth.client, conversationId);
  const probe = insertTest ? await probeAlertInsert(auth.client, conversationId) : null;

  console.log("[escalation-debug] GET /api/debug/escalation", {
    userId: auth.user.id,
    conversationId,
    diagnosticsOk: report.ok,
    insertTest,
    insertOk: probe ? probe.insert.ok : null,
    cleanupOk: probe ? probe.cleanup.ok : null,
  });

  return Response.json(
    {
      ok: report.ok,
      // Diagnostics are read-only and belong to the caller's own session.
      data: report.data ?? null,
      error: report.error ?? null,
      hint: report.hint ?? null,
      insertTest: probe,
    },
    { status: report.ok ? 200 : 502, headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}
