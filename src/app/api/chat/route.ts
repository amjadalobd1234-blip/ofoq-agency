import { z } from "zod";

import { detectLanguage } from "@/lib/ai/language";
import { completeOfoqChat, type ChatTurn } from "@/lib/ai/assistant-chat";
import { anyProviderConfigured, firstConfiguredProvider, providerLabel } from "@/lib/ai/providers";
import { aiUsageRpcArgs, safeUsageSink } from "@/lib/ai/usage";
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
  // browser only needs its display name for the "بواسطة …" badge and a flag.
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

  const completion = await completeOfoqChat({
    history: turn.messages,
    latestMessage: parsed.data.message,
    locale: turn.language === "en" ? "en" : "ar",
    customerId: (customer as { id?: string } | null)?.id ?? null,
    onUsage,
  });

  const { data: savedReply, error: replyError } = await auth.client.rpc("ofoq_client_chat_reply", {
    p_conversation_id: turn.conversationId,
    p_body: completion.text,
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
    },
  }, { headers: { "Cache-Control": "no-store, max-age=0" } });
}
