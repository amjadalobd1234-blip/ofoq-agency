import { providerStatuses } from "@/lib/ai/providers";
import { emailStatus } from "@/lib/email/email-service";
import { requireSupabaseUser, requireOwnRole, rpcFailureResponse } from "@/lib/supabase/route-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/admin/ai/usage — OWNER only.
 *
 * Returns the provider table for /admin/settings/integrations:
 *   - one row per provider with 🔌 configuration state (key present or not),
 *   - today's request counters from `public.ai_usage`,
 *   - the 10 most recent AI requests.
 *
 * Keys are never returned: the browser only learns the NAME of the environment
 * variable each provider expects.
 *
 * If the `0002_ai_usage` migration has not been applied yet, the route still
 * answers with the provider list and `usageAvailable: false`, so the screen
 * stays useful while showing the setup hint.
 */
interface ProviderUsageRow {
  provider: string;
  requests: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
}

interface RecentUsageRow {
  id: string;
  provider: string;
  model: string;
  agentKey: string | null;
  customerId: string | null;
  inputTokens: number;
  outputTokens: number;
  status: string;
  durationMs: number;
  createdAt: string;
}

const MISSING_SCHEMA_CODES = ["PGRST202", "PGRST204", "42P01", "42883"];

export async function GET() {
  const auth = await requireSupabaseUser();
  if (auth.response) return auth.response;

  const owner = await requireOwnRole(auth.client, auth.user.id, ["OWNER"]);
  if (owner.response) return owner.response;

  const providers = providerStatuses().map((provider) => ({
    ...provider,
    usageToday: 0,
    failuresToday: 0,
    inputTokensToday: 0,
    outputTokensToday: 0,
  }));

  const { data, error } = await auth.client.rpc("ofoq_ai_usage_admin");

  if (error) {
    if (MISSING_SCHEMA_CODES.includes(error.code ?? "")) {
      return Response.json(
        {
          data: {
            generatedAt: new Date().toISOString(),
            usageAvailable: false,
            providers,
            recent: [] as RecentUsageRow[],
            email: emailStatus(),
          },
          notice:
            "Apply db/migrations/supabase/0002_ai_usage.sql in the Supabase SQL Editor to record AI usage.",
        },
        { status: 200, headers: { "Cache-Control": "no-store" } },
      );
    }
    return rpcFailureResponse(error);
  }

  const payload = (data ?? {}) as {
    generatedAt?: string;
    today?: ProviderUsageRow[];
    recent?: RecentUsageRow[];
  };

  const byProvider = new Map((payload.today ?? []).map((row) => [row.provider, row]));
  const merged = providers.map((provider) => {
    const usage = byProvider.get(provider.id);
    return {
      ...provider,
      usageToday: Number(usage?.requests ?? 0),
      failuresToday: Number(usage?.failures ?? 0),
      inputTokensToday: Number(usage?.inputTokens ?? 0),
      outputTokensToday: Number(usage?.outputTokens ?? 0),
    };
  });

  return Response.json(
    {
      data: {
        generatedAt: payload.generatedAt ?? new Date().toISOString(),
        usageAvailable: true,
        providers: merged,
        recent: (payload.recent ?? []).slice(0, 10),
        email: emailStatus(),
      },
    },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}
