import { z } from "zod";

import { resolveBudgetIntent } from "@/lib/agents/budget-intent";
import { requireSupabaseUser } from "@/lib/supabase/route-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/chat/budget-intent — layer 2 of the guided request's budget reader.
 *
 * Body: { message, bareNumbers? }
 *
 * The browser tries the deterministic patterns first («من 200 إلى 500»,
 * «200-500$», «ميزانيتي 350»). When they fail, the phrase is handed to the AI
 * provider chain (Groq first, `GROQ_API_KEY`) which returns the amount or range
 * only. The answer is validated and normalised here (`min <= max`, sane
 * ceiling, USD), so a model hallucination can never price a request.
 * `budget: null` means: show the client the budget options again.
 */
const bodySchema = z.object({
  message: z.string().trim().min(1).max(2000),
  /** True while the budget question itself is open (a bare «300» is a budget then). */
  bareNumbers: z.boolean().optional(),
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

  const resolution = await resolveBudgetIntent(parsed.data.message, { bareNumbers: parsed.data.bareNumbers ?? false });

  return Response.json(
    {
      data: {
        budget: resolution.budget
          ? { min: resolution.budget.min, max: resolution.budget.max, range: resolution.budget.text, amount: resolution.budget.max }
          : null,
        source: resolution.source,
        provider: resolution.provider ?? null,
      },
    },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}
