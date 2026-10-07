import { getEnv } from "@/lib/config/env";
import { IntegrationDisabledError } from "@/lib/core/errors";
import { logger } from "@/lib/core/logger";

import { verifyHmacSignature } from "./crypto";

/**
 * WhatsApp Business integration.
 *
 * STATUS: NOT CONNECTED. The agency has no WhatsApp Business account yet, so
 * this adapter reports a disabled state and never pretends a message was sent.
 *
 * Crucially, the absence of WhatsApp does NOT block anything else: web chat,
 * email and the unified inbox work today. Conversations carry a `channel`
 * column, so WhatsApp messages will appear in the same client file the moment
 * the account is linked — no schema migration, no rewrite.
 *
 * To enable later:
 *   1. Create a Meta WhatsApp Business account and a phone number id.
 *   2. Set WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ACCESS_TOKEN, WHATSAPP_VERIFY_TOKEN,
 *      WHATSAPP_APP_SECRET in .env.
 *   3. Set WHATSAPP_ENABLED=true and point the webhook at
 *      {APP_URL}/api/webhooks/whatsapp
 */
export interface WhatsAppStatus {
  provider: string;
  enabled: boolean;
  connected: boolean;
  configured: boolean;
  reasonAr: string;
  reasonEn: string;
  setupStepsAr: string[];
  setupStepsEn: string[];
  missingConfig: string[];
}

const SETUP_AR = [
  "أنشئ حساب WhatsApp Business على منصة Meta وأضف رقم الهاتف.",
  "أضف WHATSAPP_PHONE_NUMBER_ID و WHATSAPP_ACCESS_TOKEN في ملف .env.",
  "أضف WHATSAPP_VERIFY_TOKEN و WHATSAPP_APP_SECRET للتحقق من الـ webhook.",
  "اجعل WHATSAPP_ENABLED=true ثم اضبط رابط الـ webhook على /api/webhooks/whatsapp.",
];

const SETUP_EN = [
  "Create a WhatsApp Business account on Meta and register a phone number.",
  "Set WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN in .env.",
  "Set WHATSAPP_VERIFY_TOKEN and WHATSAPP_APP_SECRET to validate the webhook.",
  "Set WHATSAPP_ENABLED=true and point the webhook at /api/webhooks/whatsapp.",
];

export function whatsappStatus(): WhatsAppStatus {
  const env = getEnv();
  const missing: string[] = [];
  if (!env.whatsapp.enabled) missing.push("WHATSAPP_ENABLED=true");
  if (!env.whatsapp.phoneNumberId) missing.push("WHATSAPP_PHONE_NUMBER_ID");
  if (!env.whatsapp.accessToken) missing.push("WHATSAPP_ACCESS_TOKEN");
  if (!env.whatsapp.verifyToken) missing.push("WHATSAPP_VERIFY_TOKEN");
  if (!env.whatsapp.appSecret) missing.push("WHATSAPP_APP_SECRET");

  const configured = missing.length === 0;
  return {
    provider: env.whatsapp.provider,
    enabled: env.whatsapp.enabled,
    connected: false,
    configured,
    reasonAr:
      "تكامل واتساب غير مربوط بعد: لا يوجد حساب WhatsApp Business للوكالة حاليًا. باقي القنوات (المحادثة داخل الموقع والبريد) تعمل بشكل طبيعي.",
    reasonEn:
      "WhatsApp is not connected: the agency has no WhatsApp Business account yet. Web chat and email keep working normally.",
    setupStepsAr: SETUP_AR,
    setupStepsEn: SETUP_EN,
    missingConfig: missing,
  };
}

export interface SendMessageResult {
  sent: boolean;
  providerRef?: string;
  reason?: string;
}

export const whatsappAdapter = {
  async status(): Promise<{ connected: boolean; reasonEn: string }> {
    const status = whatsappStatus();
    return { connected: status.connected, reasonEn: status.reasonEn };
  },

  /**
   * Sends a text message. Throws while not connected so callers cannot believe a
   * message was delivered when it was not.
   */
  async sendText(_to: string, _body: string): Promise<SendMessageResult> {
    const status = whatsappStatus();
    if (!status.connected) {
      logger.info("WhatsApp send skipped (not connected)");
      throw new IntegrationDisabledError("whatsapp", status.reasonEn, {
        missingConfig: status.missingConfig,
      });
    }
    // Unreachable until the account is linked and the flow is implemented.
    return { sent: false, reason: "not_implemented" };
  },

  /**
   * Verifies a webhook subscription request (Meta hub challenge flow).
   * Returns the challenge to echo, or null when verification fails.
   */
  verifySubscription(params: { mode: string | null; token: string | null; challenge: string | null }): string | null {
    const env = getEnv();
    if (!env.whatsapp.verifyToken) return null;
    if (params.mode !== "subscribe") return null;
    if (!params.token || params.token !== env.whatsapp.verifyToken) return null;
    return params.challenge;
  },

  /** Validates the X-Hub-Signature-256 header on inbound webhook payloads. */
  verifySignature(rawBody: string, signatureHeader: string | null): boolean {
    const env = getEnv();
    if (!env.whatsapp.appSecret || !signatureHeader) return false;
    const signature = signatureHeader.replace(/^sha256=/, "");
    return verifyHmacSignature(env.whatsapp.appSecret, rawBody, signature, "hex");
  },
};

/** Inbound message shape mapped onto the platform's conversation model. */
export interface InboundWhatsAppMessage {
  from: string;
  body: string;
  timestamp: string;
  externalRef: string;
}

export function parseInboundMessage(payload: unknown): InboundWhatsAppMessage[] {
  const messages: InboundWhatsAppMessage[] = [];
  const root = payload as {
    entry?: { changes?: { value?: { messages?: { from?: string; text?: { body?: string }; timestamp?: string; id?: string }[] } }[] }[];
  };
  for (const entry of root.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const message of change.value?.messages ?? []) {
        if (!message.from || !message.text?.body) continue;
        messages.push({
          from: message.from,
          body: message.text.body,
          timestamp: message.timestamp ?? new Date().toISOString(),
          externalRef: message.id ?? "",
        });
      }
    }
  }
  return messages;
}
