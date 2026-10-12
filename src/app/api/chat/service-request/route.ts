import { z } from "zod";

import { isValidWhatsappNumber } from "@/lib/agents/service-request";
import { isValidEmail } from "@/lib/email/email-service";
import { submitServiceRequest } from "@/lib/services/service-requests.service";
import { requireSupabaseUser } from "@/lib/supabase/route-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/chat/service-request — a completed guided request.
 *
 * Body: { answers, locale?, conversationId? }
 *
 * The route validates every answer against the published options, then hands the
 * request to `submitServiceRequest()`: the prepared `offers` row (status
 * REQUESTED), the IMPORTANT/NEW_REQUEST alert in /admin/alerts, and the owner
 * email through Resend.
 *
 * Supabase is read here for the signed-in client's identity only (name, email,
 * customer id) — the deferred PR #2 binding is the one that inserts the offer.
 */
const bodySchema = z.object({
  answers: z.object({
    type: z.string().trim().max(60).optional(),
    size: z.string().trim().max(60).optional(),
    budget: z.string().trim().max(60).optional(),
    targeting: z.string().trim().max(60).optional(),
    contact: z.string().trim().max(60).optional(),
    phone: z.string().trim().max(30).optional(),
  }),
  locale: z.enum(["ar", "en"]).optional(),
  conversationId: z.string().trim().max(120).nullable().optional(),
});

const CONTACT_CHANNELS = ["whatsapp", "email", "website"] as const;

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
    return Response.json({ error: "Invalid service request." }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }

  const { answers } = parsed.data;
  const channel = CONTACT_CHANNELS.find((value) => value === answers.contact);
  if (!channel) {
    return Response.json(
      { error: `contact must be one of: ${CONTACT_CHANNELS.join(", ")}.` },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (channel === "whatsapp" && !isValidWhatsappNumber(answers.phone ?? "")) {
    return Response.json(
      { error: "A valid WhatsApp number (10–15 digits, starting with 07, +964 or 964) is required." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const { data: customer } = await auth.client
    .from("customers")
    .select("id, email, contact_name")
    .eq("user_id", auth.user.id)
    .maybeSingle();
  const profile = (customer ?? null) as { id?: string; email?: string | null; contact_name?: string | null } | null;
  const clientEmail = profile?.email ?? auth.user.email ?? null;

  const contactValue =
    channel === "whatsapp" ? (answers.phone ?? "").trim() : channel === "email" && isValidEmail(clientEmail ?? "") ? clientEmail : null;

  const submission = await submitServiceRequest({
    answers: {
      type: answers.type,
      size: answers.size,
      budget: answers.budget,
      targeting: answers.targeting,
      contact: channel,
      ...(channel === "whatsapp" ? { phone: (answers.phone ?? "").trim() } : {}),
    },
    contact: { channel, value: contactValue },
    clientEmail,
    customerId: profile?.id ?? null,
    customerName: profile?.contact_name ?? null,
    locale: parsed.data.locale === "en" ? "en" : "ar",
    conversationId: parsed.data.conversationId ?? null,
  });

  return Response.json(
    {
      data: {
        orderCode: submission.record.orderCode,
        price: submission.record.price,
        contact: submission.record.contact,
        alertId: submission.alertId,
        email: submission.email,
        // The offer row is prepared (status REQUESTED) and travels with the alert
        // until the Supabase binding of PR #2 inserts it.
        offer: { status: submission.record.offer.status, code: submission.record.offer.code },
      },
    },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}
