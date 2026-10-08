import { requireSupabaseUser, rpcFailureResponse } from "@/lib/supabase/route-auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireSupabaseUser();
  if (auth.response) return auth.response;

  const { data, error } = await auth.client.rpc("ofoq_client_dashboard");
  if (error) return rpcFailureResponse(error);
  return Response.json({ data }, { headers: { "Cache-Control": "no-store, max-age=0" } });
}
