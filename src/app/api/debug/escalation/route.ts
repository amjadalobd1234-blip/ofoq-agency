import { fetchEscalationDiagnostics } from "@/lib/services/escalation.service";
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
 *
 * It reports the caller's platform profile and client record, who owns the web
 * conversation, whether `public.alerts` exists (and whether `customer_id` is
 * still nullable), whether the `ofoq_client_escalate` RPC is installed, and who
 * would be notified. Nothing here is secret beyond the account's own profile,
 * and nothing is written.
 *
 * A structured version of the same report is also shown in section 8 of /debug.
 */
export async function GET(request: Request): Promise<Response> {
  const auth = await requireSupabaseUser();
  if (auth.response) return auth.response;

  const conversationId = new URL(request.url).searchParams.get("conversationId");
  const report = await fetchEscalationDiagnostics(auth.client, conversationId);

  return Response.json(
    {
      ok: report.ok,
      // Diagnostics are read-only and belong to the caller's own session.
      data: report.data ?? null,
      error: report.error ?? null,
      hint: report.hint ?? null,
    },
    { status: report.ok ? 200 : 502, headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}
