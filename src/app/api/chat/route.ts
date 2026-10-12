import { z } from "zod";

import { detectLanguage } from "@/lib/ai/language";
import { completeOfoqChat, type ChatTurn } from "@/lib/ai/assistant-chat";
import { anyProviderConfigured, firstConfiguredProvider, providerLabel } from "@/lib/ai/providers";
import { aiUsageRpcArgs, safeUsageSink } from "@/lib/ai/usage";
import { detectEscalation } from "@/lib/agents/escalation-agent";
import { raiseClientEscalation, type EscalationOutcome } from "@/lib/services/escalation.service";
import { fetchOwnProfile, requireSupabaseUser, rpcFailureResponse } from "@/lib/supabase/route-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Temporary escalation tracing (debug branch). Logs ids and states only, never message text. */
function trace(step: string, data: Record<string, unknown>): void {
  console.log(`[escalation-debug] ${step}`, data);
}

const messageSchema = z.object({
  message: z.string().trim().min(1).max(2000),
});

interface BootstrapPayload {
  conversationId: string;
  customerName: string;
  /** Registered address of the client, shown by the guided service request. */
  email?: string | null;
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

export async function GET(request: Request) {
  // `/api/chat` is deliberately outside the middleware matcher, so the session
  // is read from this request here (never from an ambient cookie store).
  const auth = await requireSupabaseUser(request);
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
  const auth = await requireSupabaseUser(request);
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

  trace("1 message received", { userId: auth.user.id, chars: parsed.data.message.length });

  const detected = detectLanguage(parsed.data.message);
  const { data, error } = await auth.client.rpc("ofoq_client_chat_send", {
    p_body: parsed.data.message,
    p_language: detected === "unknown" ? null : detected,
  });
  if (error) return rpcFailureResponse(error);

  const turn = data as SentPayload;
  if (!turn?.conversationId || !Array.isArray(turn.messages) || !turn.userMessage) {
    trace("2 chat turn NOT saved", { hasData: Boolean(turn), rpc: "ofoq_client_chat_send" });
    return Response.json({ error: "The conversation could not be loaded. Refresh and try again." }, { status: 502 });
  }
  console.log("[chat] message", { userId: auth.user.id, conversationId: turn.conversationId, message: parsed.data.message });
  trace("2 chat turn saved", {
    conversationId: turn.conversationId,
    historyTurns: turn.messages.length,
    locale: turn.language,
  });

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

  trace("3 assistant reply ready", { provider: completion.provider, replyChars: completion.text.length });

  // Real escalation, not a promise.
  //
  // Every assistant reply is checked: did the client ask for a person (or
  // complain), did the reply itself promise a handoff, or is the need now
  // understood enough to be a lead? When yes, an `alerts` row is written, the
  // conversation flips to PENDING, the owner is emailed, and only then is the
  // client told it happened. When the write fails, the client is told that too.
  console.log("[chat] calling detectEscalation");
  const decision = detectEscalation({
    latestMessage: parsed.data.message,
    history: turn.messages,
    assistantReply: completion.text,
  });
  console.log("[chat] escalation:", {
    escalate: decision.escalate,
    category: decision.category,
    severity: decision.severity,
    signals: decision.signals,
  });

  // Escalation must work for every signed-in account, owners included. The
  // role and the client record travel with the call so a refusal can be read
  // straight off the server log (an OWNER with no `customers` row used to be
  // indistinguishable from a wrong conversation id).
  trace("4 escalation-agent decision", {
    escalate: decision.escalate,
    category: decision.category,
    severity: decision.severity,
    signals: decision.signals,
  });

  const own = decision.escalate ? await fetchOwnProfile(auth.client, auth.user.id) : null;
  const role = own?.profile?.role ?? null;
  if (decision.escalate) {
    trace("5 caller profile", { role, hasCustomerRecord: Boolean(customer), profileReadOk: Boolean(own?.profile) });
  }

  if (decision.escalate) console.log("[chat] raising escalation");
  const escalation: EscalationOutcome | null = decision.escalate
    ? await raiseClientEscalation({
        client: auth.client,
        conversationId: turn.conversationId,
        latestMessage: parsed.data.message,
        history: turn.messages,
        locale,
        decision,
        context: {
          userId: auth.user.id,
          role,
          customerId: (customer as { id?: string } | null)?.id ?? null,
        },
      })
    : null;

  if (escalation) {
    console.log("[chat] escalation result:", {
      escalated: escalation.escalated,
      created: escalation.created,
      alertId: escalation.alertId,
      error: escalation.error ?? null,
    });
    trace("6 raiseClientEscalation outcome", {
      escalated: escalation.escalated,
      created: escalation.created,
      alertId: escalation.alertId,
      conversationStatus: escalation.conversationStatus,
      error: escalation.error ?? null,
      emailDelivered: escalation.email.delivered,
    });
  }

  const replyBody = escalation?.notice ? `${completion.text}\n\n${escalation.notice}` : completion.text;

  const { data: savedReply, error: replyError } = await auth.client.rpc("ofoq_client_chat_reply", {
    p_conversation_id: turn.conversationId,
    p_body: replyBody,
    p_language: turn.language,
    p_provider: completion.provider,
  });
  if (replyError) {
    trace("7 reply NOT saved", { rpc: "ofoq_client_chat_reply", code: replyError.code ?? null, message: replyError.message ?? null });
    return rpcFailureResponse(replyError);
  }
  trace("7 reply saved", {
    conversationId: turn.conversationId,
    noticeAppended: Boolean(escalation?.notice),
    escalated: Boolean(escalation?.escalated),
  });

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
