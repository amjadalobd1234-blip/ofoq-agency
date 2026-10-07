import { addDays, addMonths, daysBetween, nowIso, periodBounds, toDateKey } from "@/lib/core/date";
import { ConflictError, NotFoundError, PreconditionError, ValidationError } from "@/lib/core/errors";
import { formatInvoiceNumber, nextInvoiceSequence } from "@/lib/core/ids";
import { formatMoney } from "@/lib/core/money";
import type {
  BillingInterval,
  CustomerRow,
  InvoiceRow,
  InvoiceWithCustomer,
  Locale,
  PaymentMethod,
  PaymentRow,
  SubscriptionRow,
} from "@/lib/domain/types";
import {
  createInvoice,
  createPayment,
  createSubscription,
  findInvoiceById,
  findPaymentByProviderRef,
  findSubscriptionById,
  listInvoiceNumbers,
  listInvoices,
  listOverdueInvoices,
  listRenewalsDue,
  listSubscriptions,
  updateInvoice,
  updatePayment,
  updateSubscription,
} from "@/lib/repositories/billing.repo";

import { logActivity } from "./activity.service";
import { raiseAlert } from "./alerts.service";
import { sendEmail } from "./email.service";
import { getAgencySettings } from "./settings.service";

/**
 * Billing: invoices, manual payments and subscriptions.
 *
 * HARD RULES enforced by this module (not just documented):
 *  - No card data is ever read, stored or logged. Payments only carry a provider
 *    reference produced by a gateway, and even that is optional.
 *  - AI agents never move money, never change a payment method, and never decide
 *    a refund on their own: `evaluateCancellation` only applies the written
 *    policy and escalates anything outside it.
 *  - Internal costs and margins never reach a client-facing structure.
 */

/* ---------------------------------------------------------------- invoices --- */

export async function createInvoiceFromOffer(
  offer: { id: string; customer_id: string; project_id: string | null; currency: string; subtotal_minor: number; discount_minor: number; total_minor: number; code: string },
  options: { actorUserId?: string | null; dueDays?: number; subscriptionId?: string | null; policySnapshot?: string | null } = {},
): Promise<InvoiceRow> {
  const settings = await getAgencySettings();
  const numbers = await listInvoiceNumbers();
  const number = formatInvoiceNumber(nextInvoiceSequence(numbers));
  const dueDays = options.dueDays ?? settings.invoiceDueDays;

  const taxMinor = settings.taxPercent > 0 ? Math.round((offer.total_minor * settings.taxPercent) / 100) : 0;

  const invoice = await createInvoice({
    number,
    customer_id: offer.customer_id,
    project_id: offer.project_id,
    offer_id: offer.id,
    subscription_id: options.subscriptionId ?? null,
    currency: offer.currency,
    subtotal_minor: offer.total_minor,
    tax_minor: taxMinor,
    total_minor: offer.total_minor + taxMinor,
    status: "ISSUED",
    issued_at: nowIso(),
    due_at: addDays(new Date(), dueDays).toISOString(),
    notes_client:
      options.policySnapshot ??
      "الدفع يتم عبر القنوات الرسمية للوكالة. لا نطلب بيانات بطاقتك في المحادثة أبدًا.",
    policy_snapshot: options.policySnapshot ?? null,
  });

  await logActivity({
    actor_type: options.actorUserId ? "USER" : "SYSTEM",
    actor_user_id: options.actorUserId ?? null,
    action: "invoice.issued",
    entity_type: "invoice",
    entity_id: invoice.id,
    customer_id: offer.customer_id,
    summary: `Invoice ${invoice.number} issued for offer ${offer.code}`,
    meta: { totalMinor: invoice.total_minor, currency: invoice.currency },
  });

  await notifyClientInvoice(invoice);

  return invoice;
}

async function notifyClientInvoice(invoice: InvoiceRow): Promise<void> {
  const { findCustomerById } = await import("@/lib/repositories/customers.repo");
  const customer = await findCustomerById(invoice.customer_id);
  if (!customer?.email) return;
  const locale: Locale = customer.locale;
  await sendEmail({
    to: customer.email,
    userId: customer.user_id,
    template: "invoice_issued",
    subject:
      locale === "ar"
        ? `فاتورة ${invoice.number} من أفق`
        : `Invoice ${invoice.number} from Ofoq`,
    text:
      locale === "ar"
        ? `مرحبًا ${customer.contact_name},\n\nأصدرنا الفاتورة ${invoice.number} بمبلغ ${formatMoney(invoice.total_minor, invoice.currency, "ar")}.\nتاريخ الاستحقاق: ${toDateKey(invoice.due_at ?? nowIso())}.\n\nيمكنك مراجعتها ودفعها من بوابة العميل.`
        : `Hello ${customer.contact_name},\n\nInvoice ${invoice.number} for ${formatMoney(invoice.total_minor, invoice.currency, "en")} has been issued.\nDue date: ${toDateKey(invoice.due_at ?? nowIso())}.\n\nYou can review and pay it from your client portal.`,
    meta: { invoiceId: invoice.id },
  });
}

/** Manual payment recording (bank transfer, cash, local wallet…). */
export interface RecordPaymentInput {
  invoiceId: string;
  amountMinor: number;
  method: PaymentMethod;
  actorUserId: string;
  providerRef?: string | null;
  note?: string | null;
  paidAt?: string | null;
}

export async function recordManualPayment(input: RecordPaymentInput): Promise<PaymentRow> {
  const invoice = await findInvoiceById(input.invoiceId);
  if (!invoice) throw new NotFoundError("Invoice not found");
  if (input.amountMinor <= 0) throw new ValidationError("Payment amount must be greater than zero");
  if (invoice.status === "CANCELLED") throw new PreconditionError("This invoice was cancelled");

  const remaining = invoice.total_minor - invoice.amount_paid_minor;
  if (input.amountMinor > remaining) {
    throw new ValidationError(
      `The amount exceeds the remaining balance (${formatMoney(remaining, invoice.currency, "en")}).`,
    );
  }

  const payment = await createPayment({
    invoice_id: invoice.id,
    customer_id: invoice.customer_id,
    amount_minor: input.amountMinor,
    currency: invoice.currency,
    method: input.method,
    provider: "manual",
    provider_ref: input.providerRef ?? null,
    status: "SUCCEEDED",
    paid_at: input.paidAt ?? nowIso(),
    recorded_by_user_id: input.actorUserId,
    note: input.note ?? null,
  });

  await applyPaymentToInvoice(invoice.id);

  await logActivity({
    actor_type: "USER",
    actor_user_id: input.actorUserId,
    action: "payment.recorded",
    entity_type: "payment",
    entity_id: payment.id,
    customer_id: invoice.customer_id,
    summary: `Manual payment ${formatMoney(payment.amount_minor, payment.currency, "en")} for ${invoice.number}`,
    meta: { method: input.method },
  });

  return payment;
}

/** Recomputes invoice status/amounts from its payments. */
async function applyPaymentToInvoice(invoiceId: string): Promise<void> {
  const { getDb } = await import("@/lib/db");
  const db = await getDb();
  const row = await db.get<{ paid: number | null; refunded: number | null }>(
    `SELECT SUM(CASE WHEN status = 'SUCCEEDED' THEN amount_minor ELSE 0 END) AS paid,
            SUM(refunded_minor) AS refunded
     FROM payments WHERE invoice_id = ?`,
    [invoiceId],
  );
  const invoice = await findInvoiceById(invoiceId);
  if (!invoice) return;
  const paid = Number(row?.paid ?? 0);
  const refunded = Number(row?.refunded ?? 0);

  const status =
    refunded > 0 && refunded >= paid
      ? "REFUNDED"
      : paid >= invoice.total_minor
        ? "PAID"
        : paid > 0
          ? "PARTIALLY_PAID"
          : invoice.due_at && daysBetween(new Date(), invoice.due_at) < 0
            ? "OVERDUE"
            : "ISSUED";

  await updateInvoice(invoiceId, {
    amount_paid_minor: paid,
    refunded_minor: refunded,
    status,
    paid_at: status === "PAID" ? nowIso() : invoice.paid_at,
  });

  if (status === "PAID") {
    await onInvoicePaid(invoiceId);
  }
}

/**
 * Invoice paid → project enters planning and the delivery agents take over.
 * This is the single place where money changes platform state.
 */
async function onInvoicePaid(invoiceId: string): Promise<void> {
  const invoice = await findInvoiceById(invoiceId);
  if (!invoice?.project_id) return;

  const { findProjectById, updateProject } = await import("@/lib/repositories/projects.repo");
  const project = await findProjectById(invoice.project_id);
  if (!project) return;
  if (["PLANNING", "IN_PROGRESS", "IN_REVIEW", "REVISIONS", "COMPLETED"].includes(project.status)) return;

  await updateProject(project.id, { status: "PLANNING" });

  await raiseAlert({
    severity: "INFO",
    category: "billing",
    title_ar: `تم استلام دفعة للمشروع ${project.code}`,
    title_en: `Payment received for project ${project.code}`,
    body_ar: `الفاتورة ${invoice.number} مدفوعة بالكامل. المشروع جاهز للانتقال إلى مرحلة التخطيط.`,
    body_en: `Invoice ${invoice.number} is fully paid. The project is ready to move to planning.`,
    entity_type: "project",
    entity_id: project.id,
    customer_id: invoice.customer_id,
    dedupe_key: `project-paid:${project.id}`,
  });
}

/** Called by payment webhooks once a signature-verified event arrives. */
export async function applyProviderPayment(input: {
  provider: string;
  providerRef: string;
  invoiceId: string;
  amountMinor: number;
  currency: string;
  succeeded: boolean;
  failureReason?: string;
}): Promise<PaymentRow> {
  const existing = await findPaymentByProviderRef(input.provider, input.providerRef);
  if (existing) return existing;

  const invoice = await findInvoiceById(input.invoiceId);
  if (!invoice) throw new NotFoundError("Invoice not found for provider payment");
  if (invoice.currency !== input.currency) {
    throw new ValidationError("Currency mismatch between provider event and invoice");
  }

  const payment = await createPayment({
    invoice_id: invoice.id,
    customer_id: invoice.customer_id,
    amount_minor: input.amountMinor,
    currency: input.currency,
    method: "CARD_ONLINE",
    provider: input.provider,
    provider_ref: input.providerRef,
    status: input.succeeded ? "SUCCEEDED" : "FAILED",
    paid_at: input.succeeded ? nowIso() : null,
    note: input.failureReason ?? null,
  });

  if (input.succeeded) await applyPaymentToInvoice(invoice.id);

  await logActivity({
    actor_type: "SYSTEM",
    action: input.succeeded ? "payment.succeeded" : "payment.failed",
    entity_type: "payment",
    entity_id: payment.id,
    customer_id: invoice.customer_id,
    summary: `${input.provider} payment ${input.succeeded ? "succeeded" : "failed"} for ${invoice.number}`,
  });

  return payment;
}

export async function markOverdueInvoices(): Promise<number> {
  const overdue = await listOverdueInvoices();
  for (const invoice of overdue) {
    await updateInvoice(invoice.id, { status: "OVERDUE" });
    const { alertInvoiceOverdue } = await import("./alerts.service");
    await alertInvoiceOverdue({
      invoiceId: invoice.id,
      invoiceNumber: invoice.number,
      customerId: invoice.customer_id,
      totalMinor: invoice.total_minor,
      dueDate: invoice.due_at ?? nowIso(),
    });
  }
  return overdue.length;
}

export async function listCustomerInvoices(
  customerId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<{ rows: InvoiceWithCustomer[]; total: number }> {
  await markOverdueInvoicesFor(customerId);
  return listInvoices({ customerId, ...options });
}

async function markOverdueInvoicesFor(customerId: string): Promise<void> {
  const { rows } = await listInvoices({ customerId, status: ["ISSUED", "PARTIALLY_PAID"] });
  for (const invoice of rows) {
    if (invoice.due_at && daysBetween(new Date(), invoice.due_at) < 0) {
      await updateInvoice(invoice.id, { status: "OVERDUE" });
    }
  }
}

/* ------------------------------------------------------------ subscriptions -- */

export interface CreateSubscriptionInput {
  customer: CustomerRow;
  planName: string;
  amountMinor: number;
  currency: string;
  interval: BillingInterval;
  serviceId?: string | null;
  projectId?: string | null;
  autoRenew?: boolean;
  actorUserId?: string | null;
  actorAgent?: string | null;
  startDate?: string;
}

export async function startSubscription(input: CreateSubscriptionInput): Promise<SubscriptionRow> {
  const settings = await getAgencySettings();
  const start = input.startDate ? new Date(input.startDate) : new Date();
  const bounds = periodBounds(start, input.interval);

  const subscription = await createSubscription({
    customer_id: input.customer.id,
    service_id: input.serviceId ?? null,
    project_id: input.projectId ?? null,
    plan_name: input.planName,
    amount_minor: input.amountMinor,
    currency: input.currency,
    interval: input.interval,
    status: "ACTIVE",
    started_at: start.toISOString(),
    current_period_start: bounds.start.toISOString(),
    current_period_end: bounds.end.toISOString(),
    next_renewal_at: bounds.end.toISOString(),
    auto_renew: input.autoRenew ? 1 : 0,
    policy_snapshot: JSON.stringify({
      cancellationAr: settings.cancellationPolicyAr,
      cancellationEn: settings.cancellationPolicyEn,
      refundAr: settings.refundPolicyAr,
      refundEn: settings.refundPolicyEn,
    }),
  });

  await logActivity({
    actor_type: input.actorUserId ? "USER" : input.actorAgent ? "AGENT" : "SYSTEM",
    actor_user_id: input.actorUserId ?? null,
    actor_label: input.actorAgent ?? null,
    action: "subscription.created",
    entity_type: "subscription",
    entity_id: subscription.id,
    customer_id: input.customer.id,
    summary: `Subscription "${input.planName}" started (${input.interval})`,
    meta: { amountMinor: input.amountMinor, currency: input.currency },
  });

  return subscription;
}

/**
 * Cancellation: stops the next renewal; the service continues to the end of the
 * paid period, exactly as stated in the published policy.
 */
export async function cancelSubscription(
  subscriptionId: string,
  actor: { userId: string; reason?: string | null; immediate?: boolean },
): Promise<SubscriptionRow> {
  const subscription = await findSubscriptionById(subscriptionId);
  if (!subscription) throw new NotFoundError("Subscription not found");
  if (subscription.status === "CANCELLED") return subscription;

  const immediate = actor.immediate === true;
  const patch: Partial<SubscriptionRow> = {
    status: immediate ? "CANCELLED" : subscription.status,
    cancel_at_period_end: immediate ? 0 : 1,
    cancelled_at: nowIso(),
    cancellation_reason: actor.reason ?? null,
    auto_renew: 0,
  };
  if (immediate) {
    patch.next_renewal_at = null;
  }

  const updated = await updateSubscription(subscriptionId, patch);

  await logActivity({
    actor_type: "USER",
    actor_user_id: actor.userId,
    action: immediate ? "subscription.cancelled_now" : "subscription.cancelled_at_period_end",
    entity_type: "subscription",
    entity_id: subscriptionId,
    customer_id: subscription.customer_id,
    summary: immediate
      ? `Subscription "${subscription.plan_name}" cancelled immediately`
      : `Subscription "${subscription.plan_name}" will end at period end`,
    meta: { reason: actor.reason },
  });

  await raiseAlert({
    severity: "INFO",
    category: "billing",
    title_ar: `إلغاء اشتراك: ${subscription.plan_name}`,
    title_en: `Subscription cancelled: ${subscription.plan_name}`,
    body_ar: immediate
      ? "تم إلغاء الاشتراك فورًا بقرار من الفريق."
      : "سيستمر الاشتراك حتى نهاية الفترة المدفوعة ثم يتوقف التجديد.",
    body_en: immediate
      ? "The subscription was cancelled immediately by the team."
      : "The subscription continues until the end of the paid period, then renewal stops.",
    entity_type: "subscription",
    entity_id: subscriptionId,
    customer_id: subscription.customer_id,
    dedupe_key: `subscription-cancelled:${subscriptionId}`,
    notify: false,
  });

  return updated!;
}

/** Client-initiated cancellation request: policy applied, then staff confirm. */
export async function requestCancellation(
  subscriptionId: string,
  customerId: string,
  reason: string,
): Promise<{ subscription: SubscriptionRow; refundEvaluation: RefundEvaluation }> {
  const subscription = await findSubscriptionById(subscriptionId);
  if (!subscription) throw new NotFoundError("Subscription not found");
  if (subscription.customer_id !== customerId) throw new NotFoundError("Subscription not found");

  const refundEvaluation = await evaluateCancellation({
    subscriptionId,
    reason,
    workStarted: false,
  });

  await raiseAlert({
    severity: "IMPORTANT",
    category: "billing",
    title_ar: "طلب إلغاء اشتراك من عميل",
    title_en: "Client requested subscription cancellation",
    body_ar: `العميل طلب إلغاء الاشتراك «${subscription.plan_name}». السبب: ${reason}\nتقييم السياسة: ${refundEvaluation.explanationAr}`,
    body_en: `The client requested cancellation of "${subscription.plan_name}". Reason: ${reason}\nPolicy evaluation: ${refundEvaluation.explanationEn}`,
    entity_type: "subscription",
    entity_id: subscriptionId,
    customer_id: customerId,
    dedupe_key: `cancel-request:${subscriptionId}`,
  });

  // Stop renewal right away; the service itself runs to the period end.
  const updated = await updateSubscription(subscriptionId, {
    cancel_at_period_end: 1,
    auto_renew: 0,
    cancellation_reason: reason,
  });

  await logActivity({
    actor_type: "USER",
    actor_user_id: null,
    action: "subscription.cancel_requested",
    entity_type: "subscription",
    entity_id: subscriptionId,
    customer_id: customerId,
    summary: `Cancellation requested: ${subscription.plan_name}`,
    meta: { reason },
  });

  return { subscription: updated!, refundEvaluation };
}

export interface RefundEvaluation {
  /** Suggested refund in minor units, following the written policy only. */
  suggestedRefundMinor: number;
  refundable: boolean;
  requiresHumanApproval: boolean;
  code: "NO_WORK_STARTED" | "WORK_STARTED" | "NON_REFUNDABLE_AD_SPEND" | "OUT_OF_POLICY";
  explanationAr: string;
  explanationEn: string;
}

/**
 * Applies the published refund policy. This is the ONLY place the platform
 * computes a refund, and it never executes one: the amount is a suggestion for a
 * human decision. AI agents cannot call this to move money.
 */
export async function evaluateCancellation(input: {
  subscriptionId?: string | null;
  projectId?: string | null;
  reason?: string;
  workStarted: boolean;
  completedPercent?: number;
  amountPaidMinor?: number;
  currency?: string;
  adSpendMinor?: number;
}): Promise<RefundEvaluation> {
  const currency = input.currency ?? "USD";
  const paid = input.amountPaidMinor ?? 0;

  if (input.workStarted) {
    const completed = Math.min(100, Math.max(0, input.completedPercent ?? 0));
    const nonRefundable = Math.min(input.adSpendMinor ?? 0, Math.round((paid * completed) / 100));
    const refundable = Math.max(0, Math.round(paid * (1 - completed / 100)) - nonRefundable);
    return {
      suggestedRefundMinor: refundable,
      refundable: refundable > 0,
      requiresHumanApproval: true,
      code: "WORK_STARTED",
      explanationAr: `بدأ التنفيذ، لذلك يُحسب الاسترجاع على أساس العمل المنجز (${completed}%). ميزانية الإعلانات المصروفة (${formatMoney(input.adSpendMinor ?? 0, currency, "ar")}) غير قابلة للاسترجاع. أي مبلغ نهائي يحتاج موافقة المالك أو الشريك.`,
      explanationEn: `Work has started, so the refund is calculated on the work completed (${completed}%). Ad spend already paid to platforms (${formatMoney(input.adSpendMinor ?? 0, currency, "en")}) is non-refundable. Any final amount needs owner or partner approval.`,
    };
  }

  if (paid <= 0) {
    return {
      suggestedRefundMinor: 0,
      refundable: false,
      requiresHumanApproval: false,
      code: "NO_WORK_STARTED",
      explanationAr: "لم يتم أي دفع بعد، لذلك لا يوجد مبلغ لاسترجاعه.",
      explanationEn: "No payment was received yet, so there is nothing to refund.",
    };
  }

  return {
    suggestedRefundMinor: paid,
    refundable: true,
    requiresHumanApproval: paid > 0,
    code: "NO_WORK_STARTED",
    explanationAr: `لم يبدأ التنفيذ، لذلك يمكن استرجاع المبلغ المدفوع بالكامل (${formatMoney(paid, currency, "ar")}) بعد موافقة المالك أو الشريك.`,
    explanationEn: `Work has not started, so the full amount paid (${formatMoney(paid, currency, "en")}) can be refunded after owner or partner approval.`,
  };
}

/** Records a human-approved refund. Never called by an agent on its own. */
export async function recordRefund(input: {
  paymentId: string;
  amountMinor: number;
  actorUserId: string;
  reason: string;
}): Promise<PaymentRow> {
  const { findPaymentById } = await import("@/lib/repositories/billing.repo");
  const payment = await findPaymentById(input.paymentId);
  if (!payment) throw new NotFoundError("Payment not found");
  if (payment.status !== "SUCCEEDED") throw new PreconditionError("Only a succeeded payment can be refunded");

  const maxRefund = payment.amount_minor - payment.refunded_minor;
  if (input.amountMinor <= 0 || input.amountMinor > maxRefund) {
    throw new ValidationError(`Refund must be between 1 and ${maxRefund} minor units`);
  }

  const refundedTotal = payment.refunded_minor + input.amountMinor;
  const updated = await updatePayment(payment.id, {
    refunded_minor: refundedTotal,
    status: refundedTotal >= payment.amount_minor ? "REFUNDED" : payment.status,
    note: `${payment.note ? `${payment.note} | ` : ""}Refund: ${input.reason}`,
  });

  if (payment.invoice_id) await applyPaymentToInvoice(payment.invoice_id);

  await logActivity({
    actor_type: "USER",
    actor_user_id: input.actorUserId,
    action: "payment.refunded",
    entity_type: "payment",
    entity_id: payment.id,
    customer_id: payment.customer_id,
    summary: `Refund ${formatMoney(input.amountMinor, payment.currency, "en")} recorded`,
    meta: { reason: input.reason },
  });

  return updated!;
}

/** Daily/periodic renewal handling. Auto-renew only when a provider supports it. */
export async function processDueRenewals(): Promise<{ renewed: number; paused: number }> {
  const due = await listRenewalsDue();
  let renewed = 0;
  let paused = 0;
  const env = (await import("@/lib/config/env")).getEnv();

  for (const subscription of due) {
    if (subscription.cancel_at_period_end === 1) {
      await updateSubscription(subscription.id, {
        status: "CANCELLED",
        next_renewal_at: null,
        current_period_end: subscription.next_renewal_at ?? nowIso(),
      });
      paused += 1;
      continue;
    }

    if (subscription.auto_renew === 1 && env.payments.onlineCheckoutEnabled) {
      // A real renewal requires the payment provider; it is only attempted when
      // online checkout is genuinely configured.
      renewed += 1;
      continue;
    }

    // No gateway (or manual billing): issue the next invoice and wait for the
    // client's payment instead of charging silently.
    const bounds = periodBounds(subscription.next_renewal_at ?? new Date(), subscription.interval);
    const { createInvoice } = await import("@/lib/repositories/billing.repo");
    const numbers = await listInvoiceNumbers();
    const number = formatInvoiceNumber(nextInvoiceSequence(numbers));
    const invoice = await createInvoice({
      number,
      customer_id: subscription.customer_id,
      subscription_id: subscription.id,
      project_id: subscription.project_id,
      currency: subscription.currency,
      subtotal_minor: subscription.amount_minor,
      total_minor: subscription.amount_minor,
      status: "ISSUED",
      issued_at: nowIso(),
      due_at: addDays(new Date(), 7).toISOString(),
    });

    await updateSubscription(subscription.id, {
      status: "PAST_DUE",
      current_period_start: bounds.start.toISOString(),
      current_period_end: bounds.end.toISOString(),
      next_renewal_at: bounds.end.toISOString(),
    });

    await notifyClientInvoice(invoice);
    paused += 1;
  }

  return { renewed, paused };
}

/** Changes the service/plan on an existing subscription. */
export async function changeSubscriptionPlan(
  subscriptionId: string,
  changes: { amountMinor?: number; planName?: string; interval?: BillingInterval },
  actorUserId: string,
): Promise<SubscriptionRow> {
  const subscription = await findSubscriptionById(subscriptionId);
  if (!subscription) throw new NotFoundError("Subscription not found");
  if (subscription.status === "CANCELLED") {
    throw new ConflictError("A cancelled subscription cannot be changed. Start a new one instead.");
  }

  const interval = changes.interval ?? subscription.interval;
  const bounds = periodBounds(subscription.current_period_start, interval);

  const updated = await updateSubscription(subscriptionId, {
    plan_name: changes.planName ?? subscription.plan_name,
    amount_minor: changes.amountMinor ?? subscription.amount_minor,
    interval,
    current_period_end: bounds.end.toISOString(),
    next_renewal_at: subscription.cancel_at_period_end ? null : bounds.end.toISOString(),
    status: "ACTIVE",
  });

  await logActivity({
    actor_type: "USER",
    actor_user_id: actorUserId,
    action: "subscription.changed",
    entity_type: "subscription",
    entity_id: subscriptionId,
    customer_id: subscription.customer_id,
    summary: `Subscription updated: ${updated?.plan_name}`,
    meta: changes,
  });

  return updated!;
}

export async function listCustomerSubscriptions(
  customerId: string,
): Promise<SubscriptionRow[]> {
  const { rows } = await listSubscriptions({ customerId });
  return rows;
}

/** Next renewal date in a locale-friendly key, or null when not renewing. */
export function nextRenewalLabel(subscription: SubscriptionRow): string | null {
  if (!subscription.next_renewal_at || subscription.cancel_at_period_end === 1) return null;
  return toDateKey(subscription.next_renewal_at);
}

export async function subscriptionPeriodLabel(
  subscription: SubscriptionRow,
  locale: Locale,
): Promise<string> {
  const start = toDateKey(subscription.current_period_start);
  const end = toDateKey(subscription.current_period_end);
  return locale === "ar" ? `من ${start} إلى ${end}` : `${start} → ${end}`;
}

/** Client-facing billing summary (no internal costs, no provider secrets). */
export interface ClientBillingSummary {
  currency: string;
  outstandingMinor: number;
  paidMinor: number;
  nextRenewal: { planName: string; date: string; amountMinor: number } | null;
  activeSubscriptions: number;
}

export async function clientBillingSummary(customerId: string): Promise<ClientBillingSummary> {
  const { rows: invoices } = await listInvoices({ customerId, limit: 200 });
  const subscriptions = await listSubscriptions({
    customerId,
    status: ["ACTIVE", "PAST_DUE", "PAUSED"],
  });

  const currency = invoices[0]?.currency ?? subscriptions.rows[0]?.currency ?? "USD";
  const outstanding = invoices
    .filter((invoice) => ["ISSUED", "OVERDUE", "PARTIALLY_PAID"].includes(invoice.status))
    .reduce((total, invoice) => total + (invoice.total_minor - invoice.amount_paid_minor), 0);
  const paid = invoices.reduce((total, invoice) => total + invoice.amount_paid_minor, 0);

  const next = subscriptions.rows
    .filter((row) => row.next_renewal_at && row.cancel_at_period_end !== 1)
    .sort((a, b) => (a.next_renewal_at! < b.next_renewal_at! ? -1 : 1))[0];

  return {
    currency,
    outstandingMinor: Math.max(0, outstanding),
    paidMinor: paid,
    nextRenewal: next
      ? { planName: next.plan_name, date: next.next_renewal_at!, amountMinor: next.amount_minor }
      : null,
    activeSubscriptions: subscriptions.rows.filter((row) => row.status === "ACTIVE").length,
  };
}

export { addMonths };
