import { z } from "zod";

import { detectLanguage } from "@/lib/ai/language";
import { completeOfoqChat, type ChatTurn } from "@/lib/ai/assistant-chat";
import { anyProviderConfigured, firstConfiguredProvider, providerLabel } from "@/lib/ai/providers";
import { aiUsageRpcArgs, safeUsageSink } from "@/lib/ai/usage";
import { detectEscalation } from "@/lib/agents/escalation-agent";
import { raiseClientEscalation, type EscalationOutcome } from "@/lib/services/escalation.service";
import { requireSupabaseUser, rpcFailureResponse } from "@/lib/supabase/route-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const messageSchema = z.object({
  message: z.string().trim().min(1).max(2000),
});

interface BootstrapPayload {
  conversationId: string;
  customerName: string;
  language: "ar" | "en";
  messages: Array<{ id: string; sender: string; body: string; language: string; createdAt: string; provider?: string | null }>;
}

interface SentPayload {
  conversationId: string;
  customerName: string;
  language: "ar" | "en";
  messages: ChatTurn[];
  userMessage: { id: string; sender: string; body: string; language: string; createdAt: string };
}

export async function GET() {
  const auth = await requireSupabaseUser();
  if (auth.response) return auth.response;

  const { data, error } = await auth.client.rpc("ofoq_client_chat_bootstrap");
  if (error) return rpcFailureResponse(error);

  // The first configured provider is what the assistant will try first; the
  // browser only needs its id/name for the connectivity notice and a flag.
  // Provider details per message are no longer shown in the client UI.
  const provider = firstConfiguredProvider();
  return Response.json({
    data: data as BootstrapPayload,
    provider: {
      name: provider?.id ?? "rules",
      label: providerLabel(provider?.id ?? "rules", "ar"),
      configured: anyProviderConfigured(),
    },
  }, { headers: { "Cache-Control": "no-store, max-age=0" } });
}

export async function POST(request: Request) {
  const auth = await requireSupabaseUser();
  if (auth.response) return auth.response;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const parsed = messageSchema.safeParse(rawBody);
  if (!parsed.success) {
    return Response.json({ error: "Message must contain between 1 and 2000 characters." }, { status: 400 });
  }

  const detected = detectLanguage(parsed.data.message);
  const { data, error } = await auth.client.rpc("ofoq_client_chat_send", {
    p_body: parsed.data.message,
    p_language: detected === "unknown" ? null : detected,
  });
  if (error) return rpcFailureResponse(error);

  const turn = data as SentPayload;
  if (!turn?.conversationId || !Array.isArray(turn.messages) || !turn.userMessage) {
    return Response.json({ error: "The conversation could not be loaded. Refresh and try again." }, { status: 502 });
  }

  // Usage rows are attributed to the signed-in client, with the caller's JWT.
  const { data: customer } = await auth.client
    .from("customers")
    .select("id")
    .eq("user_id", auth.user.id)
    .maybeSingle();
  const onUsage = safeUsageSink((entry) => auth.client.rpc("ofoq_ai_usage_record", aiUsageRpcArgs(entry)));

  const locale = turn.language === "en" ? "en" : "ar";
  const completion = await completeOfoqChat({
    history: turn.messages,
    latestMessage: parsed.data.message,
    locale,
    customerId: (customer as { id?: string } | null)?.id ?? null,
    onUsage,
  });

  // Real escalation, not a promise.
  //
  // Every assistant reply is checked: did the client ask for a person (or
  // complain), did the reply itself promise a handoff, or is the need now
  // understood enough to be a lead? When yes, an `alerts` row is written, the
  // conversation flips to PENDING, the owner is emailed, and only then is the
  // client told it happened. When the write fails, the client is told that too.
  const decision = detectEscalation({
    latestMessage: parsed.data.message,
    history: turn.messages,
    assistantReply: completion.text,
  });
  const escalation: EscalationOutcome | null = decision.escalate
    ? await raiseClientEscalation({
        client: auth.client,
        conversationId: turn.conversationId,
        latestMessage: parsed.data.message,
        history: turn.messages,
        locale,
        decision,
      })
    : null;

  const replyBody = escalation?.notice ? `${completion.text}\n\n${escalation.notice}` : completion.text;

  const { data: savedReply, error: replyError } = await auth.client.rpc("ofoq_client_chat_reply", {
    p_conversation_id: turn.conversationId,
    p_body: replyBody,
    p_language: turn.language,
    p_provider: completion.provider,
  });
  if (replyError) return rpcFailureResponse(replyError);

  return Response.json({
    data: {
      conversationId: turn.conversationId,
      userMessage: turn.userMessage,
      reply: savedReply,
      provider: completion.provider,
      providerName: completion.providerName,
      providerConfigured: anyProviderConfigured(),
      // The chat panel refreshes its provider note from this flag.
      providerAvailable: anyProviderConfigured(),
      // True only when the handoff was actually recorded for the team.
      escalated: Boolean(escalation?.escalated),
      escalation: escalation
        ? {
            category: escalation.category,
            severity: escalation.severity,
            alertId: escalation.alertId,
            created: escalation.created,
            emailDelivered: escalation.email.delivered,
          }
        : null,
    },
  }, { headers: { "Cache-Control": "no-store, max-age=0" } });
}
