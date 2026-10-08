import { requireSupabaseUser, rpcFailureResponse } from "@/lib/supabase/route-auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireSupabaseUser();
  if (auth.response) return auth.response;

  // The RPC checks the current database role again; this UI check is not the
  // authorization boundary. No service-role key is involved.
  const { data, error } = await auth.client.rpc("ofoq_admin_dashboard");
  if (error) return rpcFailureResponse(error);
  return Response.json({ data }, { headers: { "Cache-Control": "no-store, max-age=0" } });
}
