import { z } from "zod";

import { logger } from "@/lib/core/logger";
import {
  EMAIL_TEMPLATE_NAMES,
  renderEmailTemplate,
  sendTemplateEmail,
} from "@/lib/email/email-service";
import { requireSupabaseUser, requireOwnRole } from "@/lib/supabase/route-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/email/send — OWNER and PARTNER only.
 *
 * Body: { to, template, data }
 *
 *   to        recipient address (or an array of addresses)
 *   template  welcome | offer_ready | invoice | alert_owner | human_escalation
 *   data      template fields (see `renderEmailTemplate`)
 *
 * Templates are rendered server-side, so no client can inject its own HTML into
 * an agency-branded message. A missing RESEND_API_KEY does not fail the request:
 * the message is rendered and logged by the console transport, and the response
 * reports `delivered: false`.
 */
const bodySchema = z.object({
  to: z.union([z.string().trim().email().max(320), z.array(z.string().trim().email().max(320)).min(1).max(20)]),
  template: z.enum(EMAIL_TEMPLATE_NAMES),
  // Strings and numbers only: templates never need nested structures.
  data: z.record(z.union([z.string().max(4_000), z.number()])).default({}),
});

export async function POST(request: Request) {
  const auth = await requireSupabaseUser(request);
  if (auth.response) return auth.response;

  const staff = await requireOwnRole(auth.client, auth.user.id, ["OWNER", "PARTNER"], { requestId: auth.requestId });
  if (staff.response) return staff.response;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }

  const parsed = bodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return Response.json(
      { error: `to must be a valid email address and template must be one of: ${EMAIL_TEMPLATE_NAMES.join(", ")}.` },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  let template;
  try {
    template = renderEmailTemplate(parsed.data.template, parsed.data.data);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Template data is invalid." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const result = await sendTemplateEmail(parsed.data.to, template);

  if (!result.delivered) {
    // Console transport is an expected state; a real provider rejection is not.
    const isConsole = result.provider === "console";
    if (!isConsole) {
      logger.warn("Email was not delivered", { provider: result.provider, error: result.error, subject: result.subject });
    }
    return Response.json(
      {
        data: { ...result, template: parsed.data.template, transportedBy: staff.profile.role },
        ...(isConsole
          ? { notice: "RESEND_API_KEY is not configured: the message was rendered and logged, not delivered." }
          : {}),
      },
      { status: isConsole ? 202 : 502, headers: { "Cache-Control": "no-store" } },
    );
  }

  return Response.json(
    { data: { ...result, template: parsed.data.template } },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}
