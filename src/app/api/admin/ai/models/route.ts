import { AI_PROVIDER_IDS } from "@/lib/ai/providers";
import { liveModelReport } from "@/lib/ai/provider-catalog";
import { requireSupabaseUser, requireOwnRole } from "@/lib/supabase/route-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/admin/ai/models — OWNER only.
 *
 * Asks every configured provider what its `/models` endpoint serves for the
 * key in the environment, and compares that with the model IDs this project
 * calls. This is the check that catches a retired model before the connection
 * test does: `missingDeclared` lists exactly the IDs that would fail next.
 *
 * Query:   ?provider=groq   (optional, one provider instead of all five)
 * Returns: { data: { checkedAt, providers: [{ id, name, configured, declaredModels,
 *            liveModels, missingDeclared, error? }] } }
 *
 * Read-only and secret-free: model IDs and provider names only, keys are never
 * echoed back.
 */
export async function GET(request: Request) {
  const auth = await requireSupabaseUser();
  if (auth.response) return auth.response;

  const owner = await requireOwnRole(auth.client, auth.user.id, ["OWNER"]);
  if (owner.response) return owner.response;

  const requested = new URL(request.url).searchParams.get("provider")?.trim() ?? "";
  if (requested && !(AI_PROVIDER_IDS as readonly string[]).includes(requested)) {
    return Response.json(
      { error: `provider must be one of: ${AI_PROVIDER_IDS.join(", ")}.` },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const providers = await liveModelReport(requested ? { providerId: requested } : {});

  return Response.json(
    { data: { checkedAt: new Date().toISOString(), providers } },
    { headers: { "Cache-Control": "no-store" } },
  );
}
