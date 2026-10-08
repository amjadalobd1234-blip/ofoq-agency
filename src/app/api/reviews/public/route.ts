import { createSupabaseServerClient } from "@/lib/supabase/server";
import { rpcFailureResponse } from "@/lib/supabase/route-auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return Response.json({ data: [], configured: false }, { headers: { "Cache-Control": "no-store" } });

  const { data, error } = await supabase.rpc("ofoq_public_reviews");
  if (error) return rpcFailureResponse(error);
  return Response.json({ data, configured: true }, { headers: { "Cache-Control": "public, max-age=60, stale-while-revalidate=300" } });
}
