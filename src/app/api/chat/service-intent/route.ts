import { z } from "zod";

import { resolveServiceIntent } from "@/lib/agents/service-intent";
import { requireSupabaseUser } from "@/lib/supabase/route-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/chat/service-intent — layer 3 of the guided-request matcher.
 *
 * Body: { message }
 *
 * Used by the guided service request when the deterministic matcher cannot name
 * an option: the phrase is handed to the AI provider chain (Groq first,
 * `GROQ_API_KEY`) which returns the service type only. The answer is validated
 * against the published options here, so a model hallucination can never select
 * a service. `optionId: null` means: show the client the available options.
 */
const bodySchema = z.object({
  message: z.string().trim().min(1).max(2000),
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
      { error: "Message must contain between 1 and 2000 characters." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const resolution = await resolveServiceIntent(parsed.data.message);

  return Response.json(
    {
      data: {
        optionId: resolution.optionId,
        source: resolution.source,
        provider: resolution.provider ?? null,
      },
    },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}
