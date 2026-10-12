import { afterEach, describe, expect, it, vi } from "vitest";

import { getDb } from "../src/lib/db";
import { SERVICE_REQUEST_ORDER_CODE } from "../src/lib/agents/service-request";
import {
  SERVICE_REQUEST_CATEGORY,
  SERVICE_REQUEST_OFFER_STATUS,
  TEMPORARY_CUSTOMER_ID,
  prepareServiceRequestOffer,
  submitServiceRequest,
  type ServiceRequestSubmissionInput,
} from "../src/lib/services/service-requests.service";

/**
 * Finishing the guided request must leave three real traces: the prepared
 * `offers` row (status REQUESTED), the IMPORTANT/NEW_REQUEST alert the team sees
 * in /admin/alerts, and the owner email. The Supabase binding is explicitly out
 * of scope for this phase, so the row is asserted where it is handed over (the
 * alert meta) rather than in the `offers` table.
 */

const CLIENT_EMAIL = "client@example.test";
const OWNER_EMAIL = "amjadalobd1234@gmail.com";

function adsRequest(overrides: Partial<ServiceRequestSubmissionInput> = {}): ServiceRequestSubmissionInput {
  return {
    answers: { type: "ads", size: "medium", budget: "under_200", targeting: "iraq_all", contact: "email" },
    contact: { channel: "email", value: CLIENT_EMAIL },
    clientEmail: CLIENT_EMAIL,
    locale: "ar",
    conversationId: "conv-1",
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("guided service request — record, alert and owner email", () => {
  it("prepares the offers row with status REQUESTED and the calculated price", () => {
    const record = prepareServiceRequestOffer(adsRequest());

    expect(record.orderCode).toBe(SERVICE_REQUEST_ORDER_CODE);
    expect(record.offer.status).toBe(SERVICE_REQUEST_OFFER_STATUS);
    expect(record.offer.code).toBe("OFOQ-2026-001");
    // Temporary customer until PR #2 binds the Supabase client.
    expect(record.offer.customer_id).toBe(TEMPORARY_CUSTOMER_ID);
    expect(record.offer.currency).toBe("USD");
    // $200 of ads, medium, all of Iraq → 300 / 1,500 with a 900 middle value.
    expect(record.price).toEqual({ min: 300, max: 1_500, mid: 900 });
    expect(record.offer.total_minor).toBe(90_000);
    expect(record.offer.pricing_reason).toBe("service_request:ads:under_200:iraq_all");

    const breakdown = JSON.parse(record.offer.pricing_breakdown ?? "{}") as Record<string, unknown>;
    expect(breakdown).toMatchObject({
      orderCode: "OFOQ-2026-001",
      serviceType: "ads",
      size: "medium",
      budgetBand: "under_200",
      budgetAmount: 200,
      targeting: "iraq_all",
      platforms: "single",
      price: { min: 300, max: 1_500, mid: 900, currency: "USD" },
      estimatedAdDays: 16,
      contact: { channel: "email", value: CLIENT_EMAIL },
      status: "REQUESTED",
      supabaseBound: false,
    });
    expect(breakdown.expectedResults).toEqual({
      impressions: [37_000, 69_000],
      visits: [370, 690],
      leads: [9, 17],
    });
    // Both languages travel with the record; the Arabic one is what the team reads.
    expect(record.summaryAr).toContain("رقم الطلب: OFOQ-2026-001");
    expect(record.summaryAr).toContain("الخدمة: إعلانات");
    expect(record.summaryAr).toContain("الظهور المتوقع: 37,000 - 69,000");
    expect(record.summaryEn).toContain("Order reference: OFOQ-2026-001");
    expect(record.summaryEn).toContain("Expected impressions: 37,000 - 69,000");
  });

  it("raises the IMPORTANT / NEW_REQUEST alert with the whole request in its body", async () => {
    const result = await submitServiceRequest(adsRequest());

    expect(result.alertId).toBeTruthy();
    const [alert] = await getDb().then((db) =>
      db.query<{
        severity: string;
        category: string;
        title_ar: string;
        body_ar: string;
        entity_type: string;
        entity_id: string;
        target_role: string;
        dedupe_key: string;
        meta: string;
      }>(
        "SELECT severity, category, title_ar, body_ar, entity_type, entity_id, target_role, dedupe_key, meta FROM alerts WHERE id = ?",
        [result.alertId],
      ),
    );

    expect(alert).toMatchObject({
      severity: "IMPORTANT",
      category: SERVICE_REQUEST_CATEGORY,
      title_ar: "طلب خدمة جديد #OFOQ-2026-001",
      entity_type: "service_request",
      entity_id: SERVICE_REQUEST_ORDER_CODE,
      target_role: "ANY_STAFF",
      dedupe_key: "service-request:OFOQ-2026-001",
    });
    // The client's own answers, not a summary the team has to chase.
    expect(alert.body_ar).toContain("الخدمة: إعلانات");
    expect(alert.body_ar).toContain("الحجم: متوسط");
    expect(alert.body_ar).toContain("الميزانية: 200$");
    expect(alert.body_ar).toContain("المنطقة المستهدفة: 🇮🇶 العراق كله");
    expect(alert.body_ar).toContain(`قناة التواصل: البريد الإلكتروني — ${CLIENT_EMAIL}`);
    expect(alert.body_ar).toContain("الظهور المتوقع: 37,000 - 69,000");
    expect(alert.body_ar).toContain("المهتمون المتوقعون: 9 - 17");
    expect(alert.body_ar).toContain("OFOQ-2026-001");

    const meta = JSON.parse(alert.meta) as { offer?: { status?: string; code?: string }; supabaseBound?: boolean };
    expect(meta.supabaseBound).toBe(false);
    expect(meta.offer).toMatchObject({ status: "REQUESTED", code: "OFOQ-2026-001" });
  });

  it("emails the owner through Resend with the order in the subject", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "email-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await submitServiceRequest(adsRequest());

    expect(result.email.delivered).toBe(true);
    expect(result.email.subject).toBe("🔔 طلب خدمة جديد #OFOQ-2026-001");
    expect(result.email.to).toEqual([OWNER_EMAIL]);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("api.resend.com");
    const body = JSON.parse(String(init.body)) as { subject: string; to: string[]; html: string };
    expect(body.to).toEqual([OWNER_EMAIL]);
    expect(body.subject).toBe("🔔 طلب خدمة جديد #OFOQ-2026-001");
    expect(body.html).toContain("#OFOQ-2026-001");
    expect(body.html).toContain("إعلانات");
    expect(body.html).toContain(CLIENT_EMAIL);
  });

  it("still answers the client when the alert or the email fails", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("provider down", { status: 502 })));

    const result = await submitServiceRequest(adsRequest({ answers: { ...adsRequest().answers, budget: "200_500" } }));

    expect(result.record.orderCode).toBe("OFOQ-2026-001");
    expect(result.email.delivered).toBe(false);
    expect(result.email.error).toBeTruthy();
  });

  it("records the submission in the activity log", async () => {
    const result = await submitServiceRequest(adsRequest());

    const [activity] = await getDb().then((db) =>
      db.query<{ action: string; entity_type: string; entity_id: string; actor_label: string }>(
        "SELECT action, entity_type, entity_id, actor_label FROM activities WHERE entity_id = ? ORDER BY created_at DESC",
        [SERVICE_REQUEST_ORDER_CODE],
      ),
    );

    expect(activity).toMatchObject({
      action: "service_request.submitted",
      entity_type: "service_request",
      entity_id: SERVICE_REQUEST_ORDER_CODE,
      actor_label: "pricing-agent",
    });
    expect(result.record.orderCode).toBe(SERVICE_REQUEST_ORDER_CODE);
  });
});
