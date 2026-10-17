import { z } from "zod";

import { isValidWhatsappNumber, typedBudget } from "@/lib/agents/service-request";
import { isValidEmail } from "@/lib/email/email-service";
import {
  ServiceRequestStoreError,
  buildServiceRequestContact,
  submitServiceRequest,
  supabaseServiceRequestStore,
} from "@/lib/services/service-requests.service";
import { requireSupabaseUser } from "@/lib/supabase/route-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/chat/service-request — a completed guided request.
 *
 * Body: { requestId?, answers, locale?, conversationId? }
 *
 * The route validates every answer against the published options, then hands the
 * request to `submitServiceRequest()` with the Supabase store: one transaction
 * (RPC `ofoq_client_service_request`, hardened by migration 0010) writes the `offers` row
 * (status DRAFT until the REQUESTED status lands) and the IMPORTANT /
 * NEW_REQUEST alert for /admin/alerts, then the owner is emailed through Resend.
 *
 * This path is separate from the human-handoff escalation (`ofoq_client_escalate`,
 * HUMAN_REQUEST / URGENT): a new request never goes through it.
 *
 * A save failure is answered with a clear error (never a silent 200) so the chat
 * can tell the client and offer a retry — `requestId` makes the retry idempotent.
 */
const bodySchema = z.object({
  requestId: z.string().trim().min(8).max(80).regex(/^[A-Za-z0-9_-]+$/).optional(),
  answers: z.object({
    type: z.string().trim().max(60).optional(),
    size: z.string().trim().max(60).optional(),
    budget: z.string().trim().max(60).optional(),
    budgetRange: z.string().trim().max(40).optional(),
    budgetAmount: z.string().trim().max(20).optional(),
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

  // Identity for the alert body only; the RPC resolves the customer row itself.
  interface CustomerProfile { id?: string; email?: string | null; contact_name?: string | null }
  let profile: CustomerProfile | null = null;
  try {
    const { data } = await auth.client
      .from("customers")
      .select("id, email, contact_name")
      .eq("user_id", auth.user.id)
      .maybeSingle();
    profile = (data ?? null) as CustomerProfile | null;
  } catch {
    profile = null;
  }
  const clientEmail = profile?.email ?? auth.user.email ?? null;

  const contactValue =
    channel === "whatsapp" ? (answers.phone ?? "").trim() : channel === "email" && isValidEmail(clientEmail ?? "") ? clientEmail : null;

  // A typed budget is only kept when it is consistent with its band; otherwise
  // the band alone is stored (the pricing then uses the band's upper bound).
  const budgetAnswers = { budget: answers.budget, budgetRange: answers.budgetRange, budgetAmount: answers.budgetAmount };
  const typed = typedBudget(budgetAnswers);

  const requestId = parsed.data.requestId ?? crypto.randomUUID();
  const locale = parsed.data.locale === "en" ? "en" : "ar";

  try {
    const submission = await submitServiceRequest(
      {
        requestId,
        answers: {
          type: answers.type,
          size: answers.size,
          budget: answers.budget,
          ...(typed ? { budgetRange: typed.range, budgetAmount: String(typed.amount) } : {}),
          targeting: answers.targeting,
          contact: channel,
          ...(channel === "whatsapp" ? { phone: (answers.phone ?? "").trim() } : {}),
        },
        contact: buildServiceRequestContact(channel, contactValue),
        clientEmail,
        customerId: profile?.id ?? null,
        customerName: profile?.contact_name ?? null,
        locale,
        conversationId: parsed.data.conversationId ?? null,
      },
      { store: supabaseServiceRequestStore(auth.client) },
    );

    return auth.finalize(
      Response.json(
        {
          data: {
            requestId,
            orderCode: submission.orderCode,
            offerId: submission.offerId,
            offerStatus: submission.offerStatus,
            created: submission.created,
            price: submission.record.price,
            budget: submission.record.budgetDetail,
            contact: submission.record.contact,
            alertId: submission.alertId,
            alert: submission.alert,
            email: submission.email,
            offer: { status: submission.offerStatus, code: submission.orderCode },
          },
        },
        { headers: { "Cache-Control": "no-store, max-age=0" } },
      ),
    );
  } catch (error) {
    if (error instanceof ServiceRequestStoreError) {
      return auth.finalize(
        Response.json(
          {
            error: error.message,
            code: error.code,
            hint: error.hint,
            requestId,
            correlationId: auth.requestId,
          },
          { status: error.status, headers: { "Cache-Control": "no-store" } },
        ),
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    // eslint-disable-next-line no-console
    console.error("[service-request] unexpected failure", { requestId, correlationId: auth.requestId, error: message });
    return auth.finalize(
      Response.json(
        { error: "The request could not be saved.", code: "SERVICE_REQUEST_SAVE_FAILED", requestId, correlationId: auth.requestId },
        { status: 500, headers: { "Cache-Control": "no-store" } },
      ),
    );
  }
}
