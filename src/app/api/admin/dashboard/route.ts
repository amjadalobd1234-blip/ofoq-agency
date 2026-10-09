import { requireSupabaseUser, rpcFailureResponse } from "@/lib/supabase/route-auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireSupabaseUser();
  if (auth.response) {
    // eslint-disable-next-line no-console
    console.error("[api/admin/dashboard] no authenticated Supabase user for this request (session/cookie issue, not RLS).");
    return auth.response;
  }

  // The RPC checks the current database role again; this UI check is not the
  // authorization boundary. No service-role key is involved.
  const { data, error } = await auth.client.rpc("ofoq_admin_dashboard");
  if (error) {
    // Full Supabase/Postgres error server-side only — never sent to the browser.
    // eslint-disable-next-line no-console
    console.error("[api/admin/dashboard] ofoq_admin_dashboard RPC failed:", {
      message: error.message,
      code: error.code,
      details: (error as { details?: string }).details,
      hint: (error as { hint?: string }).hint,
      userId: auth.user.id,
    });
    return rpcFailureResponse(error);
  }
  return Response.json({ data }, { headers: { "Cache-Control": "no-store, max-age=0" } });
}
