/**
 * Guided service requests — the record, the staff alert and the owner email.
 *
 * A client who finishes the guided request in the assistant chat produces three
 * things:
 *
 *   1. a prepared row for the `offers` table with status `REQUESTED`, carrying
 *      the service type, size, budget, target area, the calculated price range
 *      (minimum, maximum and middle value), the chosen contact channel and its
 *      data, and the order reference;
 *   2. an alert in /admin/alerts (severity IMPORTANT, category NEW_REQUEST) that
 *      shows the whole request to the team;
 *   3. an email to the agency owner through Resend.
 *
 * Scope of this phase: **no Supabase binding**. The client record is addressed
 * with a temporary `customer_id`, and the prepared offer row is attached to the
 * alert (`meta.offer`) instead of being inserted. PR #2 wires the Supabase
 * client and turns `prepareServiceRequestOffer()` into the real insert — the
 * payload, the status and the order reference stay exactly as they are here
 * (`OFOQ-2026-001`, fixed for testing).
 */
import { getEnv } from "@/lib/config/env";
import { logger } from "@/lib/core/logger";
import type { Locale, OfferRow } from "@/lib/domain/types";
import { sendTemplateEmail, serviceRequestOwnerTemplate } from "@/lib/email/email-service";
import {
  SERVICE_REQUEST_ORDER_CODE,
  optionLabel,
  requestPricingInput,
  type ServiceRequestAnswers,
  type ServiceRequestOption,
} from "@/lib/agents/service-request";
import { calculateServiceEstimate, formatCount, type PricingResult } from "@/lib/agents/pricing-agent";
import { DEFAULT_OWNER_EMAIL } from "@/lib/services/escalation.service";
import { raiseAlert } from "@/lib/services/alerts.service";
import { logActivity } from "@/lib/services/activity.service";

/**
 * Temporary owner of a service request. The real `customers.id` travels with
 * the signed-in client; until the Supabase binding lands (PR #2) the prepared
 * offer row is labelled with this clearly fake id so nothing can be mistaken
 * for a production record.
 */
export const TEMPORARY_CUSTOMER_ID = "temp-customer-ofoq-0001";

/**
 * Status of the prepared offer row, written by PR #2's insert.
 *
 * Note for PR #2: the `offers.status` CHECK in db/migrations/sqlite/0001_core.sql
 * still lists only DRAFT / SENT / APPROVED / REJECTED / EXPIRED / CANCELLED, so
 * the insert needs a migration that adds REQUESTED (SQLite cannot alter a CHECK
 * in place) mirrored into db/migrations/postgres and docs/setup/supabase-setup.sql
 * through `npm run db:generate-postgres`. Nothing is inserted in this phase, so
 * the schema stays untouched here.
 */
export const SERVICE_REQUEST_OFFER_STATUS = "REQUESTED" as const;

export const SERVICE_REQUEST_CATEGORY = "NEW_REQUEST" as const;

export interface ServiceRequestContact {
  channel: "email" | "whatsapp" | "website";
  /** Registered email address, or the WhatsApp number the client typed. */
  value: string | null;
}

export interface ServiceRequestSubmissionInput {
  answers: ServiceRequestAnswers;
  contact: ServiceRequestContact;
  /** Registered client email (shown to the client and inside the alert). */
  clientEmail?: string | null;
  /** Real client id when a signed-in customer exists; temporary id otherwise. */
  customerId?: string | null;
  customerName?: string | null;
  locale?: Locale;
  conversationId?: string | null;
}

/**
 * The offers row as it will be written once Supabase is connected. Every field
 * of the table that matters for a request is filled; money is in minor units,
 * exactly like the rest of the platform.
 */
export interface PreparedServiceRequestOffer {
  code: string;
  customer_id: string;
  status: typeof SERVICE_REQUEST_OFFER_STATUS;
  currency: "USD";
  /** Middle value of the published price range, in cents. */
  total_minor: number;
  subtotal_minor: number;
  discount_minor: number;
  internal_cost_minor: number;
  margin_pct: null;
  project_id: null;
  valid_until: null;
  pricing_reason: string;
  /** JSON payload with the request, the full price range and the contact channel. */
  pricing_breakdown: string;
  client_note: string;
  internal_note: string;
  created_by_agent: string;
  created_by_user_id: null;
  approved_at: null;
  rejected_at: null;
  is_demo: 0;
}

export interface ServiceRequestRecord {
  orderCode: string;
  customerId: string;
  service: string;
  size: string;
  budget: string;
  targetArea: string;
  price: { min: number | null; max: number | null; mid: number | null };
  contact: ServiceRequestContact;
  platforms: string;
  estimatedAdDays: number | null;
  summaryAr: string;
  summaryEn: string;
  offer: PreparedServiceRequestOffer;
}

function contactChannelLabel(channel: ServiceRequestContact["channel"]): ServiceRequestOption {
  const labels: Record<ServiceRequestContact["channel"], ServiceRequestOption> = {
    whatsapp: { id: "whatsapp", labelAr: "واتساب", labelEn: "WhatsApp" },
    email: { id: "email", labelAr: "البريد الإلكتروني", labelEn: "Email" },
    website: { id: "website", labelAr: "إشعار في الموقع", labelEn: "In-app notification" },
  };
  return labels[channel];
}

function priceRangeLabel(result: PricingResult, locale: Locale): string {
  if (result.minPrice === null || result.maxPrice === null) {
    return locale === "ar" ? "يحتاج مراجعة" : "Needs review";
  }
  const ar = locale === "ar";
  return ar
    ? `${result.minPrice}$ - ${result.maxPrice}$ (المتوسط ${result.midPrice ?? 0}$)`
    : `$${result.minPrice} - $${result.maxPrice} (mid $${result.midPrice ?? 0})`;
}

/** Builds the summary shown in the alert and in the owner email. */
export function serviceRequestRecordSummary(
  input: ServiceRequestSubmissionInput,
  locale: Locale,
  result: PricingResult,
): string {
  const ar = locale === "ar";
  const channel = contactChannelLabel(input.contact.channel);
  const lines = [
    ar ? `رقم الطلب: ${SERVICE_REQUEST_ORDER_CODE}` : `Order reference: ${SERVICE_REQUEST_ORDER_CODE}`,
    ar ? `الخدمة: ${optionLabel("TYPE", input.answers.type, locale)}` : `Service: ${optionLabel("TYPE", input.answers.type, locale)}`,
    ar ? `الحجم: ${optionLabel("SIZE", input.answers.size, locale)}` : `Size: ${optionLabel("SIZE", input.answers.size, locale)}`,
    ar ? `الميزانية: ${result.budgetAmount}$` : `Budget: $${result.budgetAmount}`,
    ar
      ? `المنطقة المستهدفة: ${optionLabel("TARGETING", input.answers.targeting, locale)}`
      : `Target area: ${optionLabel("TARGETING", input.answers.targeting, locale)}`,
    ar ? `عدد المنصات: ${result.platforms === "single" ? "منصة واحدة" : "عدة منصات"}` : `Platforms: ${result.platforms}`,
    ar ? `نطاق السعر: ${priceRangeLabel(result, locale)}` : `Price range: ${priceRangeLabel(result, locale)}`,
    ar
      ? `قناة التواصل: ${channel.labelAr}${input.contact.value ? ` — ${input.contact.value}` : ""}`
      : `Contact channel: ${channel.labelEn}${input.contact.value ? ` — ${input.contact.value}` : ""}`,
  ];
  if (input.clientEmail) lines.push(ar ? `بريد العميل: ${input.clientEmail}` : `Client email: ${input.clientEmail}`);
  if (input.customerName) lines.push(ar ? `اسم العميل: ${input.customerName}` : `Client name: ${input.customerName}`);
  if (result.resultsKind === "numbers" && result.expectedReach && result.expectedVisits && result.expectedLeads) {
    const count = (value: number): string => formatCount(value, locale);
    lines.push(
      ar
        ? `الظهور المتوقع: ${count(result.expectedReach[0])} - ${count(result.expectedReach[1])}`
        : `Expected impressions: ${count(result.expectedReach[0])} - ${count(result.expectedReach[1])}`,
      ar
        ? `الزيارات المتوقعة: ${count(result.expectedVisits[0])} - ${count(result.expectedVisits[1])}`
        : `Expected visits: ${count(result.expectedVisits[0])} - ${count(result.expectedVisits[1])}`,
      ar
        ? `المهتمون المتوقعون: ${count(result.expectedLeads[0])} - ${count(result.expectedLeads[1])}`
        : `Expected leads: ${count(result.expectedLeads[0])} - ${count(result.expectedLeads[1])}`,
    );
  }
  return lines.join("\n");
}

/**
 * Prepares the `offers` row (status REQUESTED) for this request. Pure: it can be
 * unit-tested and reused by the PR #2 insert without touching a database.
 */
export function prepareServiceRequestOffer(input: ServiceRequestSubmissionInput): ServiceRequestRecord {
  const locale: Locale = input.locale === "en" ? "en" : "ar";
  const result = calculateServiceEstimate(requestPricingInput(input.answers));
  const channel = contactChannelLabel(input.contact.channel);
  const customerId = input.customerId?.trim() || TEMPORARY_CUSTOMER_ID;
  const summaryAr = serviceRequestRecordSummary(input, "ar", result);
  const summaryEn = serviceRequestRecordSummary(input, "en", result);

  const pricingBreakdown = JSON.stringify({
    orderCode: SERVICE_REQUEST_ORDER_CODE,
    serviceType: result.service,
    size: input.answers.size ?? null,
    budgetBand: result.budgetBand,
    budgetAmount: result.budgetAmount,
    targeting: result.targeting,
    platforms: result.platforms,
    price: { min: result.minPrice, max: result.maxPrice, mid: result.midPrice, currency: "USD" },
    expectedResults:
      result.resultsKind === "numbers"
        ? {
            impressions: result.expectedReach,
            visits: result.expectedVisits,
            leads: result.expectedLeads,
          }
        : null,
    estimatedAdDays: result.estimatedAdDays,
    contact: { channel: input.contact.channel, value: input.contact.value },
    clientEmail: input.clientEmail ?? null,
    conversationId: input.conversationId ?? null,
    customerId,
    status: SERVICE_REQUEST_OFFER_STATUS,
    supabaseBound: false,
  });

  const totalMinor = Math.round((result.midPrice ?? 0) * 100);

  const offer: PreparedServiceRequestOffer = {
    code: SERVICE_REQUEST_ORDER_CODE,
    customer_id: customerId,
    status: SERVICE_REQUEST_OFFER_STATUS,
    currency: "USD",
    total_minor: totalMinor,
    subtotal_minor: totalMinor,
    discount_minor: 0,
    internal_cost_minor: 0,
    margin_pct: null,
    project_id: null,
    valid_until: null,
    pricing_reason: `service_request:${result.service}:${result.budgetBand}:${result.targeting}`,
    pricing_breakdown: pricingBreakdown,
    client_note:
      locale === "ar"
        ? `طلب خدمة ${optionLabel("TYPE", input.answers.type, locale)} — رقم الطلب ${SERVICE_REQUEST_ORDER_CODE}`
        : `${optionLabel("TYPE", input.answers.type, locale)} service request — order ${SERVICE_REQUEST_ORDER_CODE}`,
    internal_note: `قناة التواصل: ${channel.labelAr}${input.contact.value ? ` — ${input.contact.value}` : ""}`,
    created_by_agent: "pricing-agent",
    created_by_user_id: null,
    approved_at: null,
    rejected_at: null,
    is_demo: 0,
  };

  return {
    orderCode: SERVICE_REQUEST_ORDER_CODE,
    customerId,
    service: optionLabel("TYPE", input.answers.type, locale),
    size: optionLabel("SIZE", input.answers.size, locale),
    budget: `${result.budgetAmount}$`,
    targetArea: optionLabel("TARGETING", input.answers.targeting, locale),
    price: { min: result.minPrice, max: result.maxPrice, mid: result.midPrice },
    contact: input.contact,
    platforms: result.platforms,
    estimatedAdDays: result.estimatedAdDays,
    summaryAr,
    summaryEn,
    offer,
  };
}

export interface ServiceRequestSubmissionResult {
  record: ServiceRequestRecord;
  alertId: string | null;
  email: { delivered: boolean; to: string[]; provider: string; subject: string; error?: string };
}

function ownerRecipients(): string[] {
  const configured = getEnv().email.ownerEmails;
  return configured.length > 0 ? configured : [DEFAULT_OWNER_EMAIL];
}

/**
 * Completes a service request: prepares the offer row, raises the staff alert
 * (IMPORTANT / NEW_REQUEST) and emails the owner. Neither the alert nor the
 * email failure stops the client — both are reported in the result.
 */
export async function submitServiceRequest(
  input: ServiceRequestSubmissionInput,
): Promise<ServiceRequestSubmissionResult> {
  const record = prepareServiceRequestOffer(input);
  const locale: Locale = input.locale === "en" ? "en" : "ar";
  const titleAr = `طلب خدمة جديد #${record.orderCode}`;
  const titleEn = `New service request #${record.orderCode}`;
  const channelLabel = contactChannelLabel(record.contact.channel);
  const channelTextAr = `${channelLabel.labelAr}${record.contact.value ? ` — ${record.contact.value}` : ""}`;
  const channelTextEn = `${channelLabel.labelEn}${record.contact.value ? ` — ${record.contact.value}` : ""}`;

  let alertId: string | null = null;
  try {
    const alert = await raiseAlert({
      severity: "IMPORTANT",
      category: SERVICE_REQUEST_CATEGORY,
      title_ar: titleAr,
      title_en: titleEn,
      body_ar: record.summaryAr,
      body_en: record.summaryEn,
      entity_type: "service_request",
      entity_id: record.orderCode,
      customer_id: null,
      target_role: "ANY_STAFF",
      dedupe_key: `service-request:${record.orderCode}`,
      // The prepared offers row travels with the alert until PR #2 inserts it.
      meta: { offer: record.offer, contact: record.contact, channelAr: channelTextAr, supabaseBound: false },
      notify: true,
    });
    alertId = alert.id;
  } catch (error) {
    logger.error("Service-request alert could not be raised", {
      orderCode: record.orderCode,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const template = serviceRequestOwnerTemplate({
    orderCode: record.orderCode,
    service: record.service,
    size: record.size,
    budget: record.budget,
    targetArea: record.targetArea,
    priceRange:
      record.price.min === null || record.price.max === null
        ? "Needs review"
        : `$${record.price.min} - $${record.price.max} (mid $${record.price.mid ?? 0})`,
    contactChannel: channelTextEn,
    locale,
  });
  const recipients = ownerRecipients();
  const delivery = await sendTemplateEmail(recipients, template);

  await logActivity({
    actor_type: "AGENT",
    actor_label: "pricing-agent",
    action: "service_request.submitted",
    entity_type: "service_request",
    entity_id: record.orderCode,
    summary: `${titleAr} — ${channelTextAr}`,
    meta: {
      orderCode: record.orderCode,
      service: record.service,
      size: record.size,
      budget: record.budget,
      targetArea: record.targetArea,
      price: record.price,
      contact: record.contact,
      alertId,
      emailDelivered: delivery.delivered,
    },
  });

  return {
    record,
    alertId,
    email: {
      delivered: delivery.delivered,
      to: delivery.to,
      provider: delivery.provider,
      subject: delivery.subject,
      error: delivery.error,
    },
  };
}

/** Shape of the prepared row as it maps onto `offers` (documentation helper). */
export type ServiceRequestOfferRow = Pick<
  OfferRow,
  "code" | "customer_id" | "currency" | "subtotal_minor" | "total_minor" | "pricing_reason" | "pricing_breakdown"
> & { status: typeof SERVICE_REQUEST_OFFER_STATUS };
