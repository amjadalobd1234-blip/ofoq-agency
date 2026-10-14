import { z } from "zod";

import { resolveStepIntent, stepIntentOptions } from "@/lib/agents/step-intent";
import { STEP_INTENT_MIN_CONFIDENCE } from "@/lib/agents/service-request";
import { requireSupabaseUser } from "@/lib/supabase/route-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/chat/step-intent — the AI intent layer of the guided request.
 *
 * Body: { step, message, options?, language? }
 *
 *   { step: "TARGETING", message: "البصرة", options: [{ value: "basra", labelAr: "البصرة فقط" }, …], language: "ar" }
 *
 * Every selection step (TYPE, SIZE, BUDGET, TARGETING, CONTACT) tries the
 * deterministic matcher first. When it cannot name an option, the chat calls
 * this route: the phrase, the step and its options go to the AI provider chain
 * (Groq first, `GROQ_API_KEY`), which answers with one option value and how sure
 * it is — `{ "match": "basra", "confidence": 0.95 }`.
 *
 * Two guards keep a model from steering a request:
 *
 *   - the choices are the step's published options. `options` sent by the
 *     browser only narrows that list; a value that is not published is dropped,
 *     and the labels the browser sent are never put in the prompt (the server
 *     uses its own, so a client cannot write the model's instructions),
 *   - the answer is accepted only when it names one of those options and its
 *     confidence is at least `STEP_INTENT_MIN_CONFIDENCE` (0.7).
 *
 * `data.match` is therefore either a real option id or `null`, and `null` means:
 * show the client the options again. The confidence is returned either way so
 * the caller can see why an answer was refused.
 */
const optionSchema = z.object({
  value: z.string().trim().min(1).max(40),
  labelAr: z.string().trim().max(80).optional(),
  labelEn: z.string().trim().max(80).optional(),
});

const bodySchema = z.object({
  step: z.enum(["TYPE", "SIZE", "BUDGET", "TARGETING", "CONTACT"]),
  message: z.string().trim().min(1).max(2000),
  /** Optional narrowing of the published options; unpublished values are ignored. */
  options: z.array(optionSchema).min(1).max(24).optional(),
  language: z.enum(["ar", "en"]).optional(),
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
      { error: "A step (TYPE, SIZE, BUDGET, TARGETING or CONTACT) and a message of 1-2000 characters are required." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const { step, message, language } = parsed.data;
  // Only the published options of this step, optionally narrowed by the caller.
  const choices = stepIntentOptions(step, parsed.data.options?.map((option) => option.value));
  const resolution = await resolveStepIntent(step, message, {
    only: choices.map((option) => option.value),
    language: language ?? "ar",
  });

  return Response.json(
    {
      data: {
        match: resolution.optionId,
        confidence: resolution.confidence,
        source: resolution.source,
        provider: resolution.provider ?? null,
        minConfidence: STEP_INTENT_MIN_CONFIDENCE,
      },
    },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}
