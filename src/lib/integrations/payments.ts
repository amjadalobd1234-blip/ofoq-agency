import { getEnv } from "@/lib/config/env";
import { IntegrationDisabledError, ValidationError } from "@/lib/core/errors";
import { formatMoney } from "@/lib/core/money";
import type { PaymentMethod } from "@/lib/domain/types";

import { verifyHmacSignature } from "./crypto";

/**
 * Payment provider abstraction.
 *
 * Runs today in `manual` mode: invoices are settled by recording a manual
 * payment (bank transfer, cash, local wallet) after a human confirms it. That is
 * a complete, working flow with no external account.
 *
 * `stripe` is scaffolded but NOT enabled: online card checkout stays off until a
 * real account is connected AND the adapter is implemented and tested against
 * it. This is deliberate — the platform must never pretend card payments work.
 *
 * Hard rules encoded here and enforced across the codebase:
 *   · the platform never stores card numbers, CVVs or expiry dates,
 *   · AI agents never receive payments, never hold card data, never initiate a
 *     transfer and never change a payment method.
 */
export interface PaymentProviderStatus {
  provider: string;
  label: string;
  onlineCheckout: boolean;
  connected: boolean;
  reason?: string;
  setupInstructionsAr: string[];
  setupInstructionsEn: string[];
  supportedMethods: PaymentMethod[];
}

export function paymentProviderStatus(): PaymentProviderStatus {
  const env = getEnv();
  if (env.payments.provider === "stripe") {
    const hasKeys = Boolean(env.payments.stripeSecretKey);
    return {
      provider: "stripe",
      label: "Stripe",
      onlineCheckout: false,
      connected: false,
      reason: hasKeys
        ? "Stripe keys are present, but the online checkout flow is not enabled yet: it has not been implemented and verified against a live account."
        : "STRIPE_SECRET_KEY is not configured.",
      setupInstructionsAr: [
        "أنشئ حساب Stripe وأكمل التحقق من الشركة.",
        "أضف STRIPE_SECRET_KEY و STRIPE_WEBHOOK_SECRET في ملف .env.",
        "أكمل تنفيذ تدفق الدفع الآلي في src/lib/integrations/payments.ts (غير منفّذ حاليًا).",
        "اختبر العملية في بيئة تجريبية قبل تشغيلها للعملاء.",
      ],
      setupInstructionsEn: [
        "Create a Stripe account and complete business verification.",
        "Add STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET to .env.",
        "Implement the automated checkout flow in src/lib/integrations/payments.ts (not implemented yet).",
        "Test end to end in test mode before enabling it for clients.",
      ],
      supportedMethods: ["MANUAL_TRANSFER", "CASH", "WALLET", "OTHER"],
    };
  }

  return {
    provider: "manual",
    label: "Manual payments",
    onlineCheckout: false,
    connected: true,
    reason:
      "Manual payments are active: staff record transfers/cash against an invoice after confirming receipt.",
    setupInstructionsAr: [
      "الدفع اليدوي مفعّل ويعمل الآن.",
      "لتشغيل الدفع الإلكتروني بالبطاقة: اربط بوابة دفع ثم أكمل تنفيذها في الكود.",
    ],
    setupInstructionsEn: [
      "Manual payment recording is active and working.",
      "To enable online card checkout: connect a gateway, then implement its adapter in the code.",
    ],
    supportedMethods: ["MANUAL_TRANSFER", "CASH", "WALLET", "CARD_ONLINE", "OTHER"],
  };
}

export interface CheckoutSession {
  url: string;
  providerRef: string;
}

/**
 * Creates an online checkout session.
 * Always throws while no provider is truly enabled — callers show the manual
 * payment instructions instead.
 */
export async function createCheckoutSession(input: {
  invoiceId: string;
  amountMinor: number;
  currency: string;
  customerEmail: string | null;
  description: string;
}): Promise<CheckoutSession> {
  const status = paymentProviderStatus();
  if (!status.onlineCheckout) {
    throw new IntegrationDisabledError(
      status.provider,
      `Online card payment is not enabled. ${status.reason ?? ""}`.trim(),
      { amount: formatMoney(input.amountMinor, input.currency, "en"), invoiceId: input.invoiceId },
    );
  }
  // Unreachable until a provider is implemented; kept explicit so no code path
  // can silently pretend a card payment was created.
  throw new IntegrationDisabledError(
    status.provider,
    "The online checkout adapter is not implemented yet.",
    { invoiceId: input.invoiceId },
  );
}

/**
 * Webhook handling for future gateway events.
 * The signature is verified with the configured secret before any state change;
 * unverified events are recorded as invalid and ignored.
 */
export interface WebhookVerification {
  valid: boolean;
  eventType: string | null;
  externalId: string | null;
  payload: Record<string, unknown>;
  reason?: string;
}

export function verifyPaymentWebhook(payload: string, signatureHeader: string | null): WebhookVerification {
  const env = getEnv();
  if (env.payments.provider === "manual") {
    return {
      valid: false,
      eventType: null,
      externalId: null,
      payload: {},
      reason: "No online payment provider is configured; webhooks cannot be processed.",
    };
  }
  if (!env.payments.stripeWebhookSecret) {
    return {
      valid: false,
      eventType: null,
      externalId: null,
      payload: {},
      reason: "STRIPE_WEBHOOK_SECRET is not configured.",
    };
  }
  if (!signatureHeader) {
    return {
      valid: false,
      eventType: null,
      externalId: null,
      payload: {},
      reason: "Missing signature header.",
    };
  }

  const valid = verifyHmacSignature(env.payments.stripeWebhookSecret, payload, signatureHeader);
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    throw new ValidationError("Webhook payload is not valid JSON");
  }

  return {
    valid,
    eventType: typeof parsed.type === "string" ? parsed.type : null,
    externalId: typeof parsed.id === "string" ? parsed.id : null,
    payload: parsed,
    reason: valid ? undefined : "Signature verification failed.",
  };
}

/** Amount/currency conversions used by gateway payloads are validated strictly. */
export function assertGatewayAmountMatches(minor: number, currency: string, expectedMinor: number, expectedCurrency: string): void {
  if (minor !== expectedMinor || currency.toUpperCase() !== expectedCurrency.toUpperCase()) {
    throw new ValidationError("The gateway amount does not match the invoice", {
      gateway: { minor, currency },
      invoice: { minor: expectedMinor, currency: expectedCurrency },
    });
  }
}
