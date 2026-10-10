import { z } from "zod";

import { AiUnavailableError, chat } from "@/lib/ai/ai-service";
import { AI_PROVIDER_IDS, providerLabel } from "@/lib/ai/providers";
import { aiUsageRpcArgs, safeUsageSink } from "@/lib/ai/usage";
import { logger } from "@/lib/core/logger";
import { requireSupabaseUser, requireOwnRole } from "@/lib/supabase/route-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/admin/ai/test — OWNER only, backing the "اختبار" button.
 *
 * Sends one tiny completion to ONE named provider (never the whole chain), so
 * the owner can see whether that key really works. The attempt is recorded in
 * `ai_usage` like any other call, which is why it also appears in "last 10".
 *
 * Body:    { providerId }
 * Returns: { data: { ok, provider, providerName, model, status, latencyMs, sample } }
 *
 * A provider that is not configured answers 200 with `ok: false` and
 * `status: "MISSING_KEY"`: that is a configuration state, not a server error.
 */
const bodySchema = z.object({
  providerId: z.string().trim().min(1).max(40),
});

export async function POST(request: Request) {
  const auth = await requireSupabaseUser();
  if (auth.response) return auth.response;

  const owner = await requireOwnRole(auth.client, auth.user.id, ["OWNER"]);
  if (owner.response) return owner.response;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }

  const parsed = bodySchema.safeParse(rawBody);
  if (!parsed.success || !(AI_PROVIDER_IDS as readonly string[]).includes(parsed.data.providerId)) {
    return Response.json(
      { error: `providerId must be one of: ${AI_PROVIDER_IDS.join(", ")}.` },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const providerId = parsed.data.providerId;
  const onUsage = safeUsageSink((entry) => auth.client.rpc("ofoq_ai_usage_record", aiUsageRpcArgs(entry)));
  const startedAt = Date.now();

  try {
    const result = await chat(
      [
        { role: "system", content: "You are a health check. Answer in one short sentence." },
        { role: "user", content: "Reply with: connection test ok" },
      ],
      {
        providerId,
        agentKey: null,
        customerId: null,
        maxTokens: 32,
        temperature: 0,
        timeoutMs: 15_000,
        onUsage,
      },
    );

    return Response.json(
      {
        data: {
          ok: true,
          provider: result.provider,
          providerName: providerLabel(result.provider, "ar"),
          model: result.model,
          status: "OK",
          latencyMs: result.usage.durationMs,
          sample: result.text.slice(0, 200),
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof AiUnavailableError) {
      const attempt = error.attempts.find((item) => item.provider === providerId);
      return Response.json(
        {
          data: {
            ok: false,
            provider: providerId,
            providerName: providerLabel(providerId, "ar"),
            model: attempt?.model ?? "",
            status: attempt?.status ?? (error.reason === "no_provider" ? "MISSING_KEY" : "PROVIDER_ERROR"),
            latencyMs: Date.now() - startedAt,
            error: attempt?.error ?? error.message,
          },
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    logger.error("AI provider test failed unexpectedly", {
      provider: providerId,
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      { error: "The provider test could not be completed." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
