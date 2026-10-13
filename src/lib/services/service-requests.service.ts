/**
 * Guided service requests — the record, the staff alert and the owner email.
 *
 * A client who finishes the guided request in the assistant chat produces three
 * things:
 *
 *   1. a row in the `offers` table (status `DRAFT` — see
 *      `SERVICE_REQUEST_OFFER_STATUS`), carrying the service type, size, budget,
 *      target area, the calculated price range, the chosen contact channel and
 *      its data, and the order reference issued by the database;
 *   2. an alert in /admin/alerts — severity IMPORTANT, category NEW_REQUEST,
 *      title «طلب خدمة جديد #<order>» — that shows the whole request to the
 *      team, including the WhatsApp number and a `wa.me` link when WhatsApp
 *      was chosen;
 *   3. an email to the agency owner through Resend.
 *
 * Persistence goes through a `ServiceRequestStore`. In production that is the
 * Supabase RPC `ofoq_client_service_request` (migration 0008), which writes the
 * offer and the alert in one transaction with the signed-in client's identity.
 * The local store writes the same two rows into the platform's own database
 * (tests, local development). The request is NEVER routed through the
 * escalation RPC (`ofoq_client_escalate`): that path produces HUMAN_REQUEST /
 * URGENT alerts, which a new request is not.
 *
 * A save failure is surfaced to the caller (`ServiceRequestStoreError`), never
 * swallowed: the route turns it into a clear error and the chat shows it.
 */
import { getEnv } from "@/lib/config/env";
import { logger } from "@/lib/core/logger";
import { nowIso } from "@/lib/core/date";
import { getDb } from "@/lib/db";
import type { Locale, OfferRow } from "@/lib/domain/types";
import { sendTemplateEmail, serviceRequestOwnerTemplate } from "@/lib/email/email-service";
import {
  budgetDisplayText,
  budgetRecordText,
  optionLabel,
  requestPricingInput,
  typedBudget,
  type ServiceRequestAnswers,
  type ServiceRequestOption,
} from "@/lib/agents/service-request";
import { calculateServiceEstimate, formatCount, type PricingResult } from "@/lib/agents/pricing-agent";
import { createCustomer, findCustomerById } from "@/lib/repositories/customers.repo";
import { createOffer } from "@/lib/repositories/offers.repo";
import { DEFAULT_OWNER_EMAIL } from "@/lib/services/escalation.service";
import { raiseAlert } from "@/lib/services/alerts.service";
import { logActivity } from "@/lib/services/activity.service";

/**
 * Owner of a request saved by the local store when no customer id is known
 * (tests, local development without Supabase). The Supabase store always uses
 * the signed-in client's own `customers` row.
 */
export const TEMPORARY_CUSTOMER_ID = "temp-customer-ofoq-0001";

/**
 * Status of the saved offer row.
 *
 * `REQUESTED` is the intended final status, but the `offers.status` CHECK
 * (db/migrations/sqlite/0001_core.sql and the Supabase schema) only allows
 * DRAFT / SENT / APPROVED / REJECTED / EXPIRED / CANCELLED today, so an insert
 * with REQUESTED fails. Until the CHECK is widened by
 * db/migrations/supabase/pending/0009_offers_requested_status.sql (the Supabase
 * "PR #2"), new requests are saved as DRAFT — the only constant to flip then.
 */
export const SERVICE_REQUEST_OFFER_STATUS = "DRAFT" as const;

export const SERVICE_REQUEST_CATEGORY = "NEW_REQUEST" as const;
export const SERVICE_REQUEST_SEVERITY = "IMPORTANT" as const;

/** The Supabase function that saves a request (never `ofoq_client_escalate`). */
export const SERVICE_REQUEST_RPC = "ofoq_client_service_request" as const;

/** Shape of the order reference the database issues: OFOQ-<year>-<sequence>. */
export const ORDER_CODE_PATTERN = /^OFOQ-\d{4}-\d{3,}$/;

export interface ServiceRequestContact {
  channel: "email" | "whatsapp" | "website";
  /** Registered email address, or the WhatsApp number exactly as the client typed it. */
  value: string | null;
  /** WhatsApp only: international number without `+` (`9647707048629`). */
  whatsappNumber?: string | null;
  /** WhatsApp only: direct chat link (`https://wa.me/9647707048629`). */
  whatsappLink?: string | null;
}

export interface ServiceRequestSubmissionInput {
  /** Idempotency key chosen by the browser; a retry with the same id returns the saved request. */
  requestId?: string | null;
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

/* ------------------------------------------------------------- WhatsApp ---- */

/**
 * Normalises a WhatsApp number typed in Iraq to the international form used by
 * `wa.me` links: digits only, `00` prefix dropped, a local `07…` number gets the
 * country code 964. Returns `null` when the input is not a usable number.
 */
export function normalizeWhatsappNumber(raw: string | null | undefined): string | null {
  const digitsOnly = (raw ?? "").replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit))).replace(/\D/g, "");
  if (!digitsOnly) return null;
  let digits = digitsOnly.startsWith("00") ? digitsOnly.slice(2) : digitsOnly;
  if (digits.startsWith("0")) digits = `964${digits.slice(1)}`;
  if (digits.length < 10 || digits.length > 15) return null;
  return digits;
}

/** Direct WhatsApp chat link for a typed number, or `null` when it is not usable. */
export function whatsappLink(raw: string | null | undefined): string | null {
  const number = normalizeWhatsappNumber(raw);
  return number ? `https://wa.me/${number}` : null;
}

/** The contact block of a request: the typed value plus the WhatsApp link when relevant. */
export function buildServiceRequestContact(
  channel: ServiceRequestContact["channel"],
  value: string | null | undefined,
): ServiceRequestContact {
  const typed = (value ?? "").trim() || null;
  if (channel !== "whatsapp") return { channel, value: typed };
  return {
    channel,
    value: typed,
    whatsappNumber: normalizeWhatsappNumber(typed),
    whatsappLink: whatsappLink(typed),
  };
}

/* --------------------------------------------------------------- record ---- */

/**
 * The offers row as it is written. Every field of the table that matters for a
 * request is filled; money is in minor units, exactly like the rest of the
 * platform. The order code is assigned by the store.
 */
export interface PreparedServiceRequestOffer {
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

export interface ServiceRequestBudget {
  /** Band id (`under_200`, `200_500`, …). */
  band: string;
  /** Canonical text: `200-500`, `350`, `<200`, `>1500`. Never «500 من 200». */
  range: string;
  /** Planning amount used by the pricing (upper bound of a range). */
  amount: number;
  /** Whether the client typed the budget or pressed a band button. */
  source: "typed" | "option";
  /** Display text with the currency: `200-500$`, `أقل من 200$`. */
  display: string;
}

export interface ServiceRequestRecord {
  requestId: string;
  customerId: string | null;
  /** The validated answers the record was built from. */
  answers: ServiceRequestAnswers;
  service: string;
  size: string;
  /** Display text of the budget (`200-500$`, `350$`, `أقل من 200$`). */
  budget: string;
  budgetDetail: ServiceRequestBudget;
  targetArea: string;
  price: { min: number | null; max: number | null; mid: number | null };
  contact: ServiceRequestContact;
  platforms: string;
  estimatedAdDays: number | null;
  summaryAr: string;
  summaryEn: string;
  offer: PreparedServiceRequestOffer;
  locale: Locale;
  conversationId: string | null;
  clientEmail: string | null;
  customerName: string | null;
  pricing: PricingResult;
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

/** The contact lines of the alert body: channel, the number as typed, and the link. */
export function contactLines(contact: ServiceRequestContact, locale: Locale): string[] {
  const ar = locale === "ar";
  const channel = contactChannelLabel(contact.channel);
  if (contact.channel === "whatsapp") {
    const lines = [
      ar ? `قناة التواصل: ${channel.labelAr}` : `Contact channel: ${channel.labelEn}`,
      ar ? `رقم العميل: ${contact.value ?? ""}` : `Client number: ${contact.value ?? ""}`,
    ];
    if (contact.whatsappLink) lines.push(ar ? `رابط واتساب: ${contact.whatsappLink}` : `WhatsApp link: ${contact.whatsappLink}`);
    return lines;
  }
  return [
    ar
      ? `قناة التواصل: ${channel.labelAr}${contact.value ? ` — ${contact.value}` : ""}`
      : `Contact channel: ${channel.labelEn}${contact.value ? ` — ${contact.value}` : ""}`,
  ];
}

/** Builds the summary shown in the alert and in the owner email. */
export function serviceRequestRecordSummary(
  input: ServiceRequestSubmissionInput,
  locale: Locale,
  result: PricingResult,
  options: { orderCode?: string | null } = {},
): string {
  const ar = locale === "ar";
  const budget = budgetDisplayText(input.answers, locale) || `${formatCount(result.budgetAmount, locale)}$`;
  const lines = [
    ...(options.orderCode ? [ar ? `رقم الطلب: ${options.orderCode}` : `Order reference: ${options.orderCode}`] : []),
    ar ? `الخدمة: ${optionLabel("TYPE", input.answers.type, locale)}` : `Service: ${optionLabel("TYPE", input.answers.type, locale)}`,
    ar ? `الحجم: ${optionLabel("SIZE", input.answers.size, locale)}` : `Size: ${optionLabel("SIZE", input.answers.size, locale)}`,
    ar ? `الميزانية: ${budget}` : `Budget: ${budget}`,
    ar
      ? `المنطقة المستهدفة: ${optionLabel("TARGETING", input.answers.targeting, locale)}`
      : `Target area: ${optionLabel("TARGETING", input.answers.targeting, locale)}`,
    ar ? `عدد المنصات: ${result.platforms === "single" ? "منصة واحدة" : "عدة منصات"}` : `Platforms: ${result.platforms}`,
    ar ? `نطاق السعر: ${priceRangeLabel(result, locale)}` : `Price range: ${priceRangeLabel(result, locale)}`,
    ...contactLines(input.contact, locale),
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

/** The budget of a request in one normalised block. */
export function serviceRequestBudget(answers: ServiceRequestAnswers, result: PricingResult): ServiceRequestBudget {
  const typed = typedBudget(answers);
  return {
    band: result.budgetBand,
    range: budgetRecordText(answers) || String(result.budgetAmount),
    amount: result.budgetAmount,
    source: typed ? "typed" : "option",
    display: budgetDisplayText(answers, "ar") || `${result.budgetAmount}$`,
  };
}

/**
 * Prepares the `offers` row (status DRAFT) and the summaries for this request.
 * Pure: no database — the stores add the order code and write it.
 */
export function prepareServiceRequestOffer(input: ServiceRequestSubmissionInput): ServiceRequestRecord {
  const locale: Locale = input.locale === "en" ? "en" : "ar";
  const result = calculateServiceEstimate(requestPricingInput(input.answers));
  const contact = buildServiceRequestContact(input.contact.channel, input.contact.value);
  const customerId = input.customerId?.trim() || null;
  const requestId = input.requestId?.trim() || crypto.randomUUID();
  const budget = serviceRequestBudget(input.answers, result);
  const summaryInput = { ...input, contact };
  const summaryAr = serviceRequestRecordSummary(summaryInput, "ar", result);
  const summaryEn = serviceRequestRecordSummary(summaryInput, "en", result);

  const pricingBreakdown = JSON.stringify({
    requestId,
    serviceType: result.service,
    size: input.answers.size ?? null,
    budgetBand: result.budgetBand,
    budgetAmount: result.budgetAmount,
    budgetRange: budget.range,
    budgetSource: budget.source,
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
    contact,
    clientEmail: input.clientEmail ?? null,
    conversationId: input.conversationId ?? null,
    customerId,
    status: SERVICE_REQUEST_OFFER_STATUS,
    source: "guided_service_request",
  });

  const totalMinor = Math.round((result.midPrice ?? 0) * 100);
  const channel = contactChannelLabel(contact.channel);

  const offer: PreparedServiceRequestOffer = {
    customer_id: customerId ?? TEMPORARY_CUSTOMER_ID,
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
        ? `طلب خدمة ${optionLabel("TYPE", input.answers.type, locale)} من المساعد الموجّه`
        : `${optionLabel("TYPE", input.answers.type, locale)} service request from the guided assistant`,
    internal_note: contactLines(contact, "ar").join(" — ") || `قناة التواصل: ${channel.labelAr}`,
    created_by_agent: "pricing-agent",
    created_by_user_id: null,
    approved_at: null,
    rejected_at: null,
    is_demo: 0,
  };

  return {
    requestId,
    customerId,
    answers: { ...input.answers },
    service: optionLabel("TYPE", input.answers.type, locale),
    size: optionLabel("SIZE", input.answers.size, locale),
    budget: budgetDisplayText(input.answers, locale) || `${result.budgetAmount}$`,
    budgetDetail: budget,
    targetArea: optionLabel("TARGETING", input.answers.targeting, locale),
    price: { min: result.minPrice, max: result.maxPrice, mid: result.midPrice },
    contact,
    platforms: result.platforms,
    estimatedAdDays: result.estimatedAdDays,
    summaryAr,
    summaryEn,
    offer,
    locale,
    conversationId: input.conversationId?.trim() || null,
    clientEmail: input.clientEmail ?? null,
    customerName: input.customerName ?? null,
    pricing: result,
  };
}

/* ---------------------------------------------------------------- alert ---- */

export interface ServiceRequestAlertPayload {
  severity: typeof SERVICE_REQUEST_SEVERITY;
  category: typeof SERVICE_REQUEST_CATEGORY;
  title_ar: string;
  title_en: string;
  body_ar: string;
  body_en: string;
  meta: {
    source: "guided_service_request";
    requestId: string;
    /** Filled by the database when it issues the code (Supabase store). */
    orderCode: string | null;
    offerStatus: typeof SERVICE_REQUEST_OFFER_STATUS;
    budget: ServiceRequestBudget;
    price: ServiceRequestRecord["price"];
    contact: ServiceRequestContact;
    /** Present only when WhatsApp was chosen — mirrors `contact` for quick reading. */
    whatsapp: { channel: "واتساب"; number: string | null; international: string | null; link: string | null } | null;
    conversationId: string | null;
    clientEmail: string | null;
  };
}

/**
 * The /admin/alerts entry of a saved request — the same payload whichever
 * store writes it. Always IMPORTANT / NEW_REQUEST with the order in the title;
 * never the HUMAN_REQUEST / URGENT shape of a human-handoff alert.
 *
 * Pass `orderCode: null` when the database issues the code itself (the
 * Supabase RPC): the title and the body are then completed in SQL.
 */
export function buildServiceRequestAlert(record: ServiceRequestRecord, orderCode: string | null): ServiceRequestAlertPayload {
  const input: ServiceRequestSubmissionInput = {
    requestId: record.requestId,
    answers: record.answers,
    contact: record.contact,
    clientEmail: record.clientEmail,
    customerName: record.customerName,
    locale: record.locale,
    conversationId: record.conversationId,
  };
  const whatsapp =
    record.contact.channel === "whatsapp"
      ? {
          channel: "واتساب" as const,
          number: record.contact.value,
          international: record.contact.whatsappNumber ?? null,
          link: record.contact.whatsappLink ?? null,
        }
      : null;
  return {
    severity: SERVICE_REQUEST_SEVERITY,
    category: SERVICE_REQUEST_CATEGORY,
    title_ar: orderCode ? `طلب خدمة جديد #${orderCode}` : "طلب خدمة جديد",
    title_en: orderCode ? `New service request #${orderCode}` : "New service request",
    body_ar: serviceRequestRecordSummary(input, "ar", record.pricing, { orderCode }),
    body_en: serviceRequestRecordSummary(input, "en", record.pricing, { orderCode }),
    meta: {
      source: "guided_service_request",
      requestId: record.requestId,
      orderCode,
      offerStatus: SERVICE_REQUEST_OFFER_STATUS,
      budget: record.budgetDetail,
      price: record.price,
      contact: record.contact,
      whatsapp,
      conversationId: record.conversationId,
      clientEmail: record.clientEmail,
    },
  };
}

/* --------------------------------------------------------------- stores ---- */

/** Thrown when the request could not be saved; the message is safe to show. */
export class ServiceRequestStoreError extends Error {
  code: string;
  status: number;
  hint: string | null;
  details: string | null;

  constructor(message: string, options: { code?: string; status?: number; hint?: string | null; details?: string | null } = {}) {
    super(message);
    this.name = "ServiceRequestStoreError";
    this.code = options.code ?? "SERVICE_REQUEST_SAVE_FAILED";
    this.status = options.status ?? 502;
    this.hint = options.hint ?? null;
    this.details = options.details ?? null;
  }
}

export interface ServiceRequestSaveResult {
  orderCode: string;
  offerId: string | null;
  offerStatus: string;
  alertId: string | null;
  /** True when this call wrote the rows; false when the request id was already saved. */
  created: boolean;
  alert: { category: string; severity: string };
}

/** Where a completed request is written: Supabase (production) or the local DB. */
export interface ServiceRequestStore {
  name: "supabase" | "local";
  save(record: ServiceRequestRecord): Promise<ServiceRequestSaveResult>;
}

/** Minimal client shape — satisfied by the Supabase server client. */
export interface ServiceRequestRpcClient {
  rpc(
    functionName: string,
    args?: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { code?: string | null; message?: string | null; details?: string | null; hint?: string | null } | null }>;
}

interface ServiceRequestRpcResult {
  requestId?: string | null;
  orderCode?: string | null;
  offerId?: string | null;
  offerStatus?: string | null;
  alertId?: string | null;
  created?: boolean | null;
  category?: string | null;
  severity?: string | null;
}

/** Turns a PostgreSQL/PostgREST error into the next thing to look at. */
export function describeServiceRequestError(code?: string | null, message?: string | null): string {
  const text = `${code ?? ""} ${message ?? ""}`;
  if (/PGRST202|42883/.test(text)) {
    return `the ${SERVICE_REQUEST_RPC} RPC is not installed — apply docs/setup/supabase-setup.sql (it bundles db/migrations/supabase/0008_service_requests.sql) in the SQL Editor, then NOTIFY pgrst, 'reload schema'`;
  }
  if (/\b23514\b/.test(text) || /offers_status_check|violates check constraint/i.test(text)) {
    return "the offers.status CHECK rejected the row — the store must write DRAFT until pending/0009_offers_requested_status.sql is applied";
  }
  if (/\b42P01\b/.test(text)) return "a table used by the request (offers / alerts / customers) does not exist — the portal schema was never fully applied";
  if (/\b42501\b/.test(text)) return "RLS/grants refused the write — the RPC must be SECURITY DEFINER and granted to authenticated";
  if (/\b28000\b/.test(text)) return "the session is not an ACTIVE platform account";
  return "unclassified service-request failure — check the Supabase logs for the RPC call";
}

/** The production store: one transaction in Supabase through migration 0008's RPC. */
export function supabaseServiceRequestStore(client: ServiceRequestRpcClient): ServiceRequestStore {
  return {
    name: "supabase",
    async save(record) {
      // The database issues the order code, completes the title («طلب خدمة
      // جديد #<code>») and prepends the order line to the body.
      const alert = buildServiceRequestAlert(record, null);
      const args = {
        p_request_id: record.requestId,
        p_title_ar: alert.title_ar,
        p_title_en: alert.title_en,
        p_body_ar: alert.body_ar,
        p_body_en: alert.body_en,
        p_offer: {
          status: record.offer.status,
          currency: record.offer.currency,
          total_minor: record.offer.total_minor,
          subtotal_minor: record.offer.subtotal_minor,
          pricing_reason: record.offer.pricing_reason,
          pricing_breakdown: JSON.parse(record.offer.pricing_breakdown) as Record<string, unknown>,
          client_note: record.offer.client_note,
          internal_note: record.offer.internal_note,
          created_by_agent: record.offer.created_by_agent,
        },
        p_contact: {
          channel: record.contact.channel,
          value: record.contact.value,
          whatsappNumber: record.contact.whatsappNumber ?? null,
          whatsappLink: record.contact.whatsappLink ?? null,
        },
        p_meta: alert.meta,
        p_conversation_id: record.conversationId,
        p_locale: record.locale,
      };

      let response: Awaited<ReturnType<ServiceRequestRpcClient["rpc"]>>;
      try {
        response = await client.rpc(SERVICE_REQUEST_RPC, args);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("[service-request] RPC call failed", { requestId: record.requestId, error: message, hint: describeServiceRequestError(null, message) });
        throw new ServiceRequestStoreError("The request could not be saved (database unreachable).", {
          code: "SERVICE_REQUEST_RPC_UNREACHABLE",
          details: message,
        });
      }

      if (response.error || !response.data) {
        const code = response.error?.code ?? null;
        const message = response.error?.message ?? "empty RPC result";
        logger.error("[service-request] offer/alert rows were not written", {
          requestId: record.requestId,
          code,
          error: message,
          details: response.error?.details ?? null,
          hint: describeServiceRequestError(code, message),
        });
        throw new ServiceRequestStoreError(
          /PGRST202|42883/.test(`${code ?? ""} ${message}`)
            ? "The request could not be saved: the service-request database function is not installed yet."
            : "The request could not be saved.",
          {
            code: /PGRST202|42883/.test(`${code ?? ""} ${message}`) ? "SERVICE_REQUEST_RPC_NOT_INSTALLED" : "SERVICE_REQUEST_SAVE_FAILED",
            hint: describeServiceRequestError(code, message),
            details: `${code ?? ""} ${message}`.trim(),
          },
        );
      }

      const result = response.data as ServiceRequestRpcResult;
      const orderCode = typeof result.orderCode === "string" ? result.orderCode : null;
      if (!orderCode) {
        throw new ServiceRequestStoreError("The request could not be saved: no order reference was returned.", {
          code: "SERVICE_REQUEST_NO_ORDER_CODE",
        });
      }
      return {
        orderCode,
        offerId: typeof result.offerId === "string" ? result.offerId : null,
        offerStatus: typeof result.offerStatus === "string" ? result.offerStatus : SERVICE_REQUEST_OFFER_STATUS,
        alertId: typeof result.alertId === "string" ? result.alertId : null,
        created: result.created !== false,
        alert: {
          category: typeof result.category === "string" ? result.category : SERVICE_REQUEST_CATEGORY,
          severity: typeof result.severity === "string" ? result.severity : SERVICE_REQUEST_SEVERITY,
        },
      };
    },
  };
}

/** Next `OFOQ-<year>-NNN` code in the local database. */
async function nextLocalOrderCode(): Promise<string> {
  const db = await getDb();
  const year = new Date().getUTCFullYear();
  const prefix = `OFOQ-${year}-`;
  const rows = await db.query<{ code: string }>("SELECT code FROM offers WHERE code LIKE ?", [`${prefix}%`]);
  const highest = rows.reduce((max, row) => {
    const sequence = Number(row.code.slice(prefix.length));
    return Number.isFinite(sequence) && sequence > max ? sequence : max;
  }, 0);
  return `${prefix}${String(highest + 1).padStart(3, "0")}`;
}

/**
 * The local store (tests, development without Supabase): the `offers` row and
 * the alert go into the platform database; the alert notifies staff through
 * the usual local notification path.
 */
export function localServiceRequestStore(): ServiceRequestStore {
  return {
    name: "local",
    async save(record) {
      const db = await getDb();
      const dedupeKey = `service-request:${record.requestId}`;

      const existing = await db.get<{ id: string; meta: string | null }>("SELECT id, meta FROM alerts WHERE dedupe_key = ?", [dedupeKey]);
      if (existing) {
        const meta = JSON.parse(existing.meta ?? "{}") as { orderCode?: string; offerId?: string };
        return {
          orderCode: meta.orderCode ?? "",
          offerId: meta.offerId ?? null,
          offerStatus: SERVICE_REQUEST_OFFER_STATUS,
          alertId: existing.id,
          created: false,
          alert: { category: SERVICE_REQUEST_CATEGORY, severity: SERVICE_REQUEST_SEVERITY },
        };
      }

      const customerId = record.customerId ?? TEMPORARY_CUSTOMER_ID;
      if (!(await findCustomerById(customerId))) {
        if (record.customerId) {
          throw new ServiceRequestStoreError("The request could not be saved: the client record does not exist.", {
            code: "SERVICE_REQUEST_CUSTOMER_MISSING",
            status: 409,
          });
        }
        await createCustomer({
          id: TEMPORARY_CUSTOMER_ID,
          contact_name: record.customerName ?? "عميل المساعد الموجّه",
          email: record.clientEmail ?? null,
          phone: record.contact.channel === "whatsapp" ? record.contact.value : null,
          source: "guided_service_request",
          status: "LEAD",
        });
      }

      const orderCode = await nextLocalOrderCode();
      let offerId: string;
      try {
        const offer = await createOffer({ ...record.offer, customer_id: customerId, code: orderCode });
        offerId = offer.id;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("[service-request] local offers insert failed", { requestId: record.requestId, error: message });
        throw new ServiceRequestStoreError("The request could not be saved.", {
          code: "SERVICE_REQUEST_SAVE_FAILED",
          hint: describeServiceRequestError(null, message),
          details: message,
        });
      }

      const alert = buildServiceRequestAlert(record, orderCode);
      const saved = await raiseAlert({
        severity: alert.severity,
        category: alert.category,
        title_ar: alert.title_ar,
        title_en: alert.title_en,
        body_ar: alert.body_ar,
        body_en: alert.body_en,
        entity_type: "service_request",
        entity_id: offerId,
        customer_id: record.customerId,
        target_role: "ANY_STAFF",
        dedupe_key: dedupeKey,
        meta: { ...alert.meta, offerId },
        notify: true,
      });

      // The client's phone becomes known through the request.
      if (record.contact.channel === "whatsapp" && record.contact.value) {
        await db.run("UPDATE customers SET phone = ?, updated_at = ? WHERE id = ? AND (phone IS NULL OR phone = '')", [
          record.contact.value,
          nowIso(),
          customerId,
        ]);
      }

      return {
        orderCode,
        offerId,
        offerStatus: SERVICE_REQUEST_OFFER_STATUS,
        alertId: saved.id,
        created: true,
        alert: { category: alert.category, severity: alert.severity },
      };
    },
  };
}

/* --------------------------------------------------------------- submit ---- */

export interface ServiceRequestSubmissionResult {
  record: ServiceRequestRecord;
  orderCode: string;
  offerId: string | null;
  offerStatus: string;
  alertId: string | null;
  alert: { category: string; severity: string };
  created: boolean;
  store: ServiceRequestStore["name"];
  email: { delivered: boolean; to: string[]; provider: string; subject: string; error?: string };
}

function ownerRecipients(): string[] {
  const configured = getEnv().email.ownerEmails;
  return configured.length > 0 ? configured : [DEFAULT_OWNER_EMAIL];
}

/**
 * Completes a service request: saves the offer row and the IMPORTANT /
 * NEW_REQUEST alert through the given store, then emails the owner and logs
 * the activity. A store failure propagates (`ServiceRequestStoreError`) so the
 * client is told the truth; an email failure is reported in the result only.
 */
export async function submitServiceRequest(
  input: ServiceRequestSubmissionInput,
  options: { store?: ServiceRequestStore } = {},
): Promise<ServiceRequestSubmissionResult> {
  const record = prepareServiceRequestOffer(input);
  const store = options.store ?? localServiceRequestStore();
  const saved = await store.save(record);
  const locale = record.locale;
  const alert = buildServiceRequestAlert(record, saved.orderCode);
  const channelLabel = contactChannelLabel(record.contact.channel);
  const channelTextAr = contactLines(record.contact, "ar").join(" — ");
  const channelTextEn = `${channelLabel.labelEn}${record.contact.value ? ` — ${record.contact.value}` : ""}${record.contact.whatsappLink ? ` — ${record.contact.whatsappLink}` : ""}`;

  if (saved.created) {
    logger.info("[service-request] saved", {
      requestId: record.requestId,
      orderCode: saved.orderCode,
      store: store.name,
      offerStatus: saved.offerStatus,
      alertId: saved.alertId,
      category: saved.alert.category,
      severity: saved.alert.severity,
    });
  }

  const template = serviceRequestOwnerTemplate({
    orderCode: saved.orderCode,
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
  const delivery = saved.created
    ? await sendTemplateEmail(recipients, template)
    : { delivered: false, to: recipients, provider: "skipped", subject: template.subject, error: "already_saved" };

  if (saved.created) {
    await logActivity({
      actor_type: "AGENT",
      actor_label: "pricing-agent",
      action: "service_request.submitted",
      entity_type: "service_request",
      entity_id: saved.offerId ?? saved.orderCode,
      summary: `${alert.title_ar} — ${channelTextAr}`,
      meta: {
        requestId: record.requestId,
        orderCode: saved.orderCode,
        offerId: saved.offerId,
        offerStatus: saved.offerStatus,
        store: store.name,
        service: record.service,
        size: record.size,
        budget: record.budgetDetail,
        targetArea: record.targetArea,
        price: record.price,
        contact: record.contact,
        alertId: saved.alertId,
        emailDelivered: delivery.delivered,
      },
    });
  }

  return {
    record,
    orderCode: saved.orderCode,
    offerId: saved.offerId,
    offerStatus: saved.offerStatus,
    alertId: saved.alertId,
    alert: saved.alert,
    created: saved.created,
    store: store.name,
    email: {
      delivered: delivery.delivered,
      to: delivery.to,
      provider: delivery.provider,
      subject: delivery.subject,
      error: delivery.error,
    },
  };
}

/** Shape of the saved row as it maps onto `offers` (documentation helper). */
export type ServiceRequestOfferRow = Pick<
  OfferRow,
  "code" | "customer_id" | "currency" | "subtotal_minor" | "total_minor" | "pricing_reason" | "pricing_breakdown"
> & { status: typeof SERVICE_REQUEST_OFFER_STATUS };
