import { z } from "zod";

import { AiUnavailableError, chat } from "@/lib/ai/ai-service";
import { providerLabel } from "@/lib/ai/providers";
import { aiUsageRpcArgs, safeUsageSink } from "@/lib/ai/usage";
import { AGENT_DEFINITION_BY_KEY } from "@/lib/agents/registry";
import { logger } from "@/lib/core/logger";
import { requireSupabaseUser } from "@/lib/supabase/route-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/ai/chat — server-side completion through the provider chain.
 *
 * Authentication is required: the route is not a public AI proxy, and every call
 * is billed against the caller's own session. Usage rows (one per provider
 * attempt) are written to `public.ai_usage` with the caller's JWT, so a client
 * cannot read another client's history.
 *
 * Body:    { messages: [{ role, content }], agentKey? }
 * Returns: { text, provider, model, providerName, usage }
 *
 * Helpers (not a hard dependency):
 *   - 503 `no_provider`  → no provider key is configured.
 *   - 502 `all_failed`   → every provider failed; callers fall back to rules.
 */
const bodySchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["system", "user", "assistant"]),
        content: z.string().trim().min(1).max(12_000),
      }),
    )
    .min(1)
    .max(40),
  agentKey: z.string().trim().min(1).max(64).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(4_096).optional(),
});

export async function POST(request: Request) {
  const auth = await requireSupabaseUser(request);
  if (auth.response) return auth.response;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }

  const parsed = bodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return Response.json(
      { error: "messages must be a non-empty array of { role, content } objects." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const agentKey = parsed.data.agentKey ?? null;
  if (agentKey && !(agentKey in AGENT_DEFINITION_BY_KEY)) {
    return Response.json(
      { error: `Unknown agentKey "${agentKey}".` },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  // Attribution only: a staff account has no customer row, which is fine.
  const { data: customer } = await auth.client
    .from("customers")
    .select("id")
    .eq("user_id", auth.user.id)
    .maybeSingle();
  const customerId = (customer as { id?: string } | null)?.id ?? null;

  const onUsage = safeUsageSink((entry) => auth.client.rpc("ofoq_ai_usage_record", aiUsageRpcArgs(entry)));

  try {
    const result = await chat(parsed.data.messages, {
      agentKey,
      customerId,
      temperature: parsed.data.temperature,
      maxTokens: parsed.data.maxTokens,
      onUsage,
    });

    return Response.json(
      {
        text: result.text,
        provider: result.provider,
        providerName: providerLabel(result.provider, "ar"),
        model: result.model,
        usage: {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          durationMs: result.usage.durationMs,
        },
      },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  } catch (error) {
    if (error instanceof AiUnavailableError) {
      // Never leak provider payloads or keys: only ids and a status per attempt.
      return Response.json(
        {
          error:
            error.reason === "no_provider"
              ? "No AI provider is configured."
              : "No AI provider could answer this request.",
          reason: error.reason,
          attempts: error.attempts.map((attempt) => ({ provider: attempt.provider, status: attempt.status })),
        },
        { status: error.reason === "no_provider" ? 503 : 502, headers: { "Cache-Control": "no-store" } },
      );
    }
    logger.error("AI chat route failed", { error: error instanceof Error ? error.message : String(error) });
    return Response.json(
      { error: "The request could not be completed." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
