import { afterEach, describe, expect, it, vi } from "vitest";

import { getDb } from "../src/lib/db";
import { plainText } from "./helpers/bidi";
import {
  ORDER_CODE_PATTERN,
  SERVICE_REQUEST_CATEGORY,
  SERVICE_REQUEST_OFFER_STATUS,
  SERVICE_REQUEST_SEVERITY,
  ServiceRequestStoreError,
  TEMPORARY_CUSTOMER_ID,
  buildServiceRequestAlert,
  buildServiceRequestContact,
  localServiceRequestStore,
  normalizeWhatsappNumber,
  prepareServiceRequestOffer,
  submitServiceRequest,
  whatsappLink,
  type ServiceRequestSubmissionInput,
} from "../src/lib/services/service-requests.service";
import { serviceRequestEstimate, serviceRequestSummary } from "../src/lib/agents/service-request";

/**
 * Finishing the guided request must leave three real traces: the `offers` row
 * (status DRAFT until the REQUESTED status lands with the Supabase PR #2), the
 * IMPORTANT / NEW_REQUEST alert the team sees in /admin/alerts, and the owner
 * email. These tests run the local store against the real schema; the Supabase
 * RPC is covered on PostgreSQL in service-request-sql-execution.test.ts.
 */

const CLIENT_EMAIL = "client@example.test";
const OWNER_EMAIL = "amjadalobd1234@gmail.com";
const TYPED_NUMBER = "07707048629";

function adsRequest(overrides: Partial<ServiceRequestSubmissionInput> = {}): ServiceRequestSubmissionInput {
  return {
    requestId: `req-${Math.random().toString(36).slice(2, 12)}`,
    answers: { type: "ads", size: "medium", budget: "under_200", targeting: "iraq_all", contact: "email" },
    contact: { channel: "email", value: CLIENT_EMAIL },
    clientEmail: CLIENT_EMAIL,
    locale: "ar",
    conversationId: "conv-1",
    ...overrides,
  };
}

function whatsappRequest(overrides: Partial<ServiceRequestSubmissionInput> = {}): ServiceRequestSubmissionInput {
  return adsRequest({
    answers: {
      type: "ads",
      size: "medium",
      budget: "200_500",
      budgetRange: "200-500",
      budgetAmount: "500",
      targeting: "iraq_all",
      contact: "whatsapp",
      phone: TYPED_NUMBER,
    },
    contact: { channel: "whatsapp", value: TYPED_NUMBER },
    ...overrides,
  });
}

async function alertRow(alertId: string | null) {
  const db = await getDb();
  return db.get<{
    severity: string;
    category: string;
    title_ar: string;
    title_en: string;
    body_ar: string;
    body_en: string;
    entity_type: string;
    entity_id: string;
    target_role: string;
    dedupe_key: string;
    meta: string;
  }>("SELECT severity, category, title_ar, title_en, body_ar, body_en, entity_type, entity_id, target_role, dedupe_key, meta FROM alerts WHERE id = ?", [alertId]);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("guided service request — the offers row", () => {
  it("prepares the offers row with status DRAFT and the calculated price", () => {
    const record = prepareServiceRequestOffer(adsRequest({ requestId: "req-prepare-1" }));

    expect(SERVICE_REQUEST_OFFER_STATUS).toBe("DRAFT");
    expect(record.requestId).toBe("req-prepare-1");
    expect(record.offer.status).toBe("DRAFT");
    // The local store labels an anonymous request with the clearly fake id.
    expect(record.customerId).toBeNull();
    expect(record.offer.customer_id).toBe(TEMPORARY_CUSTOMER_ID);
    expect(record.offer.currency).toBe("USD");
    // $200 of ads, medium, all of Iraq → 300 / 1,500 with a 900 middle value.
    expect(record.price).toEqual({ min: 300, max: 1_500, mid: 900 });
    expect(record.offer.total_minor).toBe(90_000);
    expect(record.offer.pricing_reason).toBe("service_request:ads:under_200:iraq_all");
    // A pressed band is recorded as the band, with its label for people.
    expect(record.budgetDetail).toEqual({ band: "under_200", range: "<200", amount: 200, source: "option", display: "أقل من 200$" });
    expect(record.budget).toBe("أقل من 200$");

    const breakdown = JSON.parse(record.offer.pricing_breakdown ?? "{}") as Record<string, unknown>;
    expect(breakdown).toMatchObject({
      requestId: "req-prepare-1",
      serviceType: "ads",
      size: "medium",
      budgetBand: "under_200",
      budgetAmount: 200,
      budgetRange: "<200",
      budgetSource: "option",
      targeting: "iraq_all",
      platforms: "single",
      price: { min: 300, max: 1_500, mid: 900, currency: "USD" },
      estimatedAdDays: 16,
      contact: { channel: "email", value: CLIENT_EMAIL },
      status: "DRAFT",
      source: "guided_service_request",
    });
    expect(breakdown.expectedResults).toEqual({
      impressions: [37_000, 69_000],
      visits: [370, 690],
      leads: [9, 17],
    });
    expect(record.summaryAr).toContain("الخدمة: إعلانات");
    expect(record.summaryAr).toContain("الميزانية: أقل من 200$");
    expect(plainText(record.summaryAr)).toContain("الظهور المتوقع: 37,000 - 69,000");
    expect(plainText(record.summaryEn)).toContain("Expected impressions: 37,000 - 69,000");
  });

  it("represents an unpublished `other` quote as NULL, never a displayed zero", () => {
    const record = prepareServiceRequestOffer(whatsappRequest({
      requestId: "req-other-null-1",
      answers: { ...whatsappRequest().answers, type: "other" },
    }));
    expect(record.price).toEqual({ min: null, max: null, mid: null });
    expect(record.offer.total_minor).toBeNull();
    expect(record.offer.subtotal_minor).toBeNull();
    const breakdown = JSON.parse(record.offer.pricing_breakdown) as Record<string, any>;
    expect(breakdown.price).toEqual({ min: null, max: null, mid: null, currency: "USD" });
    expect(record.summaryAr).toContain("يحتاج مراجعة");
    expect(record.summaryAr).not.toContain("$0");
  });

  it("shows the budget the client chose in the summary — the range, never the planning amount", () => {
    // Issue 4: the client pressed «200-500$» and the closing messages said
    // «ميزانيتك: $500». The mid price ($350) stays a calculation input only.
    const answers = {
      type: "ads",
      size: "medium",
      budget: "200_500",
      budgetRange: "200-500",
      budgetAmount: "500",
      targeting: "iraq_all",
      contact: "whatsapp",
      phone: TYPED_NUMBER,
    } as const;

    const summary = plainText(serviceRequestSummary({ ...answers }, "ar"));
    expect(summary).toContain("- الميزانية: 200-500$");
    expect(summary).not.toContain("- الميزانية: 500$");
    expect(summary).not.toContain("- الميزانية: 350$");

    const estimate = plainText(serviceRequestEstimate({ ...answers }, "ar"));
    expect(estimate).toContain("ميزانيتك: 200-500$");
    // The amount the estimate was actually priced on is stated separately, so
    // the range above is never mistaken for a $500 budget.
    expect(estimate).toContain("(التقدير محسوب على 500$)");
    expect(estimate).not.toMatch(/ميزانيتك: 500\$/);
    expect(estimate).not.toContain("350$");

    // The record the team reads carries the same range, not the planning amount.
    const record = prepareServiceRequestOffer(whatsappRequest({ answers: { ...answers }, requestId: "req-summary-1" }));
    expect(plainText(record.summaryAr)).toContain("الميزانية: 200-500$");
    expect({ ...record.budgetDetail, display: plainText(record.budgetDetail.display) }).toMatchObject({
      range: "200-500",
      amount: 500,
      display: "200-500$",
    });

    // The same for the pressed buttons with no typed range: the label they
    // pressed is what the client reads back.
    const optionOnly = { type: "ads", size: "medium", budget: "under_200", targeting: "iraq_all" } as const;
    expect(plainText(serviceRequestSummary({ ...optionOnly }, "ar"))).toContain("- الميزانية: أقل من 200$");
    expect(plainText(serviceRequestEstimate({ ...optionOnly }, "ar"))).toContain("ميزانيتك: أقل من 200$");
  });

  it("stores a typed range as 200-500 (never «500 من 200») and prices it on the upper bound", () => {
    const record = prepareServiceRequestOffer(whatsappRequest({ requestId: "req-range-1" }));

    expect({ ...record.budgetDetail, display: plainText(record.budgetDetail.display) }).toEqual({
      band: "200_500",
      range: "200-500",
      amount: 500,
      source: "typed",
      display: "200-500$",
    });
    expect(plainText(record.budget)).toBe("200-500$");
    expect(plainText(record.summaryAr)).toContain("الميزانية: 200-500$");
    expect(record.summaryAr).not.toContain("500 من 200");
    expect(plainText(record.summaryEn)).toContain("Budget: 200-500$");
    const breakdown = JSON.parse(record.offer.pricing_breakdown) as Record<string, unknown>;
    expect(breakdown).toMatchObject({ budgetBand: "200_500", budgetAmount: 500, budgetRange: "200-500", budgetSource: "typed" });
    // $500 → several platforms → the published multipliers for that scope.
    expect(record.platforms).toBe("multiple");
    expect(record.estimatedAdDays).toBe(30);

    // A single typed value is stored as that value.
    const single = prepareServiceRequestOffer(
      whatsappRequest({ answers: { ...whatsappRequest().answers, budget: "200_500", budgetRange: "350", budgetAmount: "350" } }),
    );
    expect(single.budgetDetail).toMatchObject({ range: "350", amount: 350, source: "typed", display: "350$" });
    expect(single.summaryAr).toContain("الميزانية: 350$");

    // Typed details that contradict the band are dropped, not trusted.
    const inconsistent = prepareServiceRequestOffer(
      whatsappRequest({ answers: { ...whatsappRequest().answers, budget: "under_200", budgetRange: "200-500", budgetAmount: "500" } }),
    );
    expect(inconsistent.budgetDetail).toMatchObject({ band: "under_200", range: "<200", amount: 200, source: "option" });
  });
});

describe("guided service request — WhatsApp contact data", () => {
  it("normalises the typed number to an international wa.me link without changing what the client typed", () => {
    expect(normalizeWhatsappNumber("07707048629")).toBe("9647707048629");
    expect(normalizeWhatsappNumber("+964 770 704 8629")).toBe("9647707048629");
    expect(normalizeWhatsappNumber("009647707048629")).toBe("9647707048629");
    expect(normalizeWhatsappNumber("9647707048629")).toBe("9647707048629");
    expect(normalizeWhatsappNumber("٠٧٧٠٧٠٤٨٦٢٩")).toBe("9647707048629");
    expect(normalizeWhatsappNumber("12345")).toBeNull();
    expect(whatsappLink("07707048629")).toBe("https://wa.me/9647707048629");

    expect(buildServiceRequestContact("whatsapp", " 07701234567 ")).toEqual({
      channel: "whatsapp",
      value: "07701234567",
      whatsappNumber: "9647701234567",
      whatsappLink: "https://wa.me/9647701234567",
    });
    expect(buildServiceRequestContact("email", CLIENT_EMAIL)).toEqual({ channel: "email", value: CLIENT_EMAIL });
  });

  it("puts the channel, the number as typed and the link in the alert body and meta", () => {
    const record = prepareServiceRequestOffer(whatsappRequest({ requestId: "req-wa-alert" }));
    const alert = buildServiceRequestAlert(record, "OFOQ-2026-007");

    expect(alert).toMatchObject({
      severity: "IMPORTANT",
      category: "NEW_REQUEST",
      title_ar: "طلب خدمة جديد #OFOQ-2026-007",
      title_en: "New service request #OFOQ-2026-007",
    });
    expect(alert.body_ar.split("\n")[0]).toBe("رقم الطلب: OFOQ-2026-007");
    expect(alert.body_ar).toContain("قناة التواصل: واتساب");
    expect(alert.body_ar).toContain(`رقم العميل: ${TYPED_NUMBER}`);
    expect(alert.body_ar).toContain("رابط واتساب: https://wa.me/9647707048629");
    expect(alert.body_en).toContain("WhatsApp link: https://wa.me/9647707048629");
    expect(alert.meta.contact).toEqual({
      channel: "whatsapp",
      value: TYPED_NUMBER,
      whatsappNumber: "9647707048629",
      whatsappLink: "https://wa.me/9647707048629",
    });
    expect(alert.meta.whatsapp).toEqual({ channel: "واتساب", number: TYPED_NUMBER, international: "9647707048629", link: "https://wa.me/9647707048629" });
    expect({ ...alert.meta.budget, display: plainText(String(alert.meta.budget.display)) }).toEqual({
      band: "200_500",
      range: "200-500",
      amount: 500,
      source: "typed",
      display: "200-500$",
    });

    // The number is whatever the client typed — a different client, a different number.
    const other = buildServiceRequestAlert(
      prepareServiceRequestOffer(whatsappRequest({ answers: { ...whatsappRequest().answers, phone: "07801112233" }, contact: { channel: "whatsapp", value: "07801112233" } })),
      "OFOQ-2026-008",
    );
    expect(other.body_ar).toContain("رقم العميل: 07801112233");
    expect(other.body_ar).toContain("رابط واتساب: https://wa.me/9647801112233");
    expect(other.body_ar).not.toContain(TYPED_NUMBER);
  });
});

describe("guided service request — saving (local store)", () => {
  it("writes the DRAFT offers row and the IMPORTANT / NEW_REQUEST alert with the order in its title", async () => {
    const result = await submitServiceRequest(whatsappRequest({ requestId: "req-save-1" }));

    expect(result.store).toBe("local");
    expect(result.created).toBe(true);
    expect(result.orderCode).toMatch(ORDER_CODE_PATTERN);
    expect(result.offerStatus).toBe("DRAFT");
    expect(result.alert).toEqual({ category: SERVICE_REQUEST_CATEGORY, severity: SERVICE_REQUEST_SEVERITY });

    const db = await getDb();
    const offer = await db.get<{ status: string; code: string; customer_id: string; pricing_breakdown: string }>(
      "SELECT status, code, customer_id, pricing_breakdown FROM offers WHERE id = ?",
      [result.offerId],
    );
    expect(offer).toMatchObject({ status: "DRAFT", code: result.orderCode, customer_id: TEMPORARY_CUSTOMER_ID });

    const alert = await alertRow(result.alertId);
    expect(alert).toMatchObject({
      severity: "IMPORTANT",
      category: "NEW_REQUEST",
      title_ar: `طلب خدمة جديد #${result.orderCode}`,
      title_en: `New service request #${result.orderCode}`,
      entity_type: "service_request",
      entity_id: result.offerId,
      target_role: "ANY_STAFF",
      dedupe_key: "service-request:req-save-1",
    });
    // Never the human-handoff shape.
    expect(alert!.category).not.toBe("HUMAN_REQUEST");
    expect(alert!.severity).not.toBe("URGENT");
    expect(alert!.body_ar).toContain(`رقم الطلب: ${result.orderCode}`);
    expect(alert!.body_ar).toContain("الخدمة: إعلانات");
    expect(plainText(alert!.body_ar)).toContain("الميزانية: 200-500$");
    expect(alert!.body_ar).toContain("قناة التواصل: واتساب");
    expect(alert!.body_ar).toContain(`رقم العميل: ${TYPED_NUMBER}`);
    expect(alert!.body_ar).toContain("رابط واتساب: https://wa.me/9647707048629");
    const meta = JSON.parse(alert!.meta) as Record<string, any>;
    expect(meta).toMatchObject({ orderCode: result.orderCode, offerId: result.offerId, offerStatus: "DRAFT", source: "guided_service_request" });
    expect(meta.whatsapp).toEqual({ channel: "واتساب", number: TYPED_NUMBER, international: "9647707048629", link: "https://wa.me/9647707048629" });

    // The customer's phone becomes known through the request.
    const customer = await db.get<{ phone: string | null }>("SELECT phone FROM customers WHERE id = ?", [TEMPORARY_CUSTOMER_ID]);
    expect(customer?.phone).toBe(TYPED_NUMBER);
  });

  it("returns the same order for a retried request id instead of a second row", async () => {
    const first = await submitServiceRequest(adsRequest({ requestId: "req-retry-1" }));
    const second = await submitServiceRequest(adsRequest({ requestId: "req-retry-1" }));

    expect(second.created).toBe(false);
    expect(second.orderCode).toBe(first.orderCode);
    expect(second.alertId).toBe(first.alertId);
    const db = await getDb();
    const rows = await db.query<{ code: string }>("SELECT code FROM offers WHERE code = ?", [first.orderCode]);
    expect(rows).toHaveLength(1);
  });

  it("issues consecutive OFOQ-<year>-NNN codes", async () => {
    const a = await submitServiceRequest(adsRequest());
    const b = await submitServiceRequest(adsRequest());
    const [, yearA, seqA] = /^OFOQ-(\d{4})-(\d+)$/.exec(a.orderCode)!;
    const [, yearB, seqB] = /^OFOQ-(\d{4})-(\d+)$/.exec(b.orderCode)!;
    expect(yearA).toBe(yearB);
    expect(Number(seqB)).toBe(Number(seqA) + 1);
  });

  it("emails the owner through Resend with the order in the subject and the WhatsApp link in the body", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "email-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await submitServiceRequest(whatsappRequest());

    expect(result.email.delivered).toBe(true);
    expect(result.email.subject).toBe(`🔔 طلب خدمة جديد #${result.orderCode}`);
    expect(result.email.to).toEqual([OWNER_EMAIL]);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("api.resend.com");
    const body = JSON.parse(String(init.body)) as { subject: string; to: string[]; html: string };
    expect(body.to).toEqual([OWNER_EMAIL]);
    expect(body.subject).toBe(`🔔 طلب خدمة جديد #${result.orderCode}`);
    expect(body.html).toContain(`#${result.orderCode}`);
    expect(body.html).toContain("إعلانات");
    expect(body.html).toContain(TYPED_NUMBER);
    expect(body.html).toContain("https://wa.me/9647707048629");
    expect(body.html).toContain("200-500$");
  });

  it("still answers the client when the email fails, but never hides a save failure", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("provider down", { status: 502 })));

    const result = await submitServiceRequest(adsRequest({ answers: { ...adsRequest().answers, budget: "200_500" } }));
    expect(result.orderCode).toMatch(ORDER_CODE_PATTERN);
    expect(result.email.delivered).toBe(false);
    expect(result.email.error).toBeTruthy();

    // A store that cannot write surfaces a typed error — the route turns it
    // into a clear response and the chat shows it with a retry.
    const broken = {
      name: "supabase" as const,
      async save() {
        throw new ServiceRequestStoreError("The request could not be saved.", { code: "SERVICE_REQUEST_SAVE_FAILED", hint: "offers_status_check" });
      },
    };
    await expect(submitServiceRequest(adsRequest(), { store: broken })).rejects.toMatchObject({
      name: "ServiceRequestStoreError",
      code: "SERVICE_REQUEST_SAVE_FAILED",
      status: 502,
    });
  });

  it("refuses a REQUESTED row in the local schema too — the reason DRAFT is used for now", async () => {
    const db = await getDb();
    await expect(
      db.run(
        `INSERT INTO offers (id, code, customer_id, status, currency, created_at, updated_at)
         VALUES ('offer-requested', 'OFOQ-9999-999', ?, 'REQUESTED', 'USD', '2026-10-12T00:00:00.000Z', '2026-10-12T00:00:00.000Z')`,
        [TEMPORARY_CUSTOMER_ID],
      ),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it("persists an unpriced local request with NULL amounts instead of zero", async () => {
    const result = await submitServiceRequest(whatsappRequest({
      requestId: "req-local-other-null-1",
      answers: { ...whatsappRequest().answers, type: "other" },
    }));
    const row = await getDb().then((db) => db.get<{ subtotal_minor: number | null; total_minor: number | null }>(
      "SELECT subtotal_minor, total_minor FROM offers WHERE id = ?",
      [result.offerId],
    ));
    expect(row).toEqual({ subtotal_minor: null, total_minor: null });
  });

  it("records the submission in the activity log", async () => {
    const result = await submitServiceRequest(adsRequest({ requestId: "req-activity-1" }));

    const [activity] = await getDb().then((db) =>
      db.query<{ action: string; entity_type: string; entity_id: string; actor_label: string; meta: string }>(
        "SELECT action, entity_type, entity_id, actor_label, meta FROM activities WHERE entity_id = ? AND action = 'service_request.submitted' ORDER BY created_at DESC",
        [result.offerId],
      ),
    );

    expect(activity).toMatchObject({
      action: "service_request.submitted",
      entity_type: "service_request",
      entity_id: result.offerId,
      actor_label: "pricing-agent",
    });
    expect(JSON.parse(activity.meta)).toMatchObject({ requestId: "req-activity-1", orderCode: result.orderCode, offerStatus: "DRAFT", store: "local" });
    // The local store is the one used here; the production route uses the Supabase RPC.
    expect(localServiceRequestStore().name).toBe("local");
  });
});
