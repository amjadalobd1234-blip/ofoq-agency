import { afterEach, describe, expect, it, vi } from "vitest";

import {
  alertOwnerTemplate,
  emailStatus,
  humanEscalationTemplate,
  invoiceTemplate,
  offerReadyTemplate,
  renderEmailTemplate,
  sendEmail,
  sendTemplateEmail,
  welcomeTemplate,
} from "../../src/lib/email/email-service";
import { callBody, callHeaders, callUrl } from "./completion-mock";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const RESEND_OK = () =>
  new Response(JSON.stringify({ id: "e2e-test-email-id" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

describe("Email service and templates", () => {
  it("renders the welcome template in Arabic by default and in English on request", () => {
    const arabic = welcomeTemplate("نور");
    expect(arabic.subject).toContain("نور");
    expect(arabic.text).toContain("مساعد أفق");
    expect(arabic.html).toContain("dir=\"rtl\"");
    expect(arabic.html).toContain("نور");

    const english = welcomeTemplate("Noor", { locale: "en" });
    expect(english.subject).toContain("Noor");
    expect(english.subject.toLowerCase()).toContain("welcome");
    expect(english.html).toContain("dir=\"ltr\"");
  });

  it("renders the offer, invoice, alert and escalation templates with their required fields", () => {
    // Arabic output places the currency after the amount; English puts it first.
    const offer = offerReadyTemplate("نور", "OFQ-O-2026-0012", 1250, { currency: "USD" });
    expect(offer.subject).toContain("OFQ-O-2026-0012");
    expect(offer.text).toContain("1,250.00");
    expect(offer.html).toContain("OFQ-O-2026-0012");

    const offerEn = offerReadyTemplate("Noor", "OFQ-O-2026-0012", 1250, { currency: "USD", locale: "en" });
    expect(offerEn.text).toContain("$1,250.00");
    expect(offerEn.html).toContain("dir=\"ltr\"");

    const invoice = invoiceTemplate("نور", "INV-2026-0007", 250, { currency: "USD", dueDate: "2026-11-01" });
    expect(invoice.subject).toContain("INV-2026-0007");
    expect(invoice.text).toContain("250.00");
    expect(invoice.text).toContain("2026-11-01");

    const alert = alertOwnerTemplate("حملة متأخرة", "تأخر رفع التقرير اليومي", { severity: "URGENT" });
    expect(alert.subject).toContain("[تنبيه أفق]");
    expect(alert.text).toContain("URGENT");
    expect(alert.text).toContain("تأخر رفع التقرير اليومي");

    const escalation = humanEscalationTemplate("نور", "أريد التحدث مع شخص", {
      clientEmail: "noor@example.test",
      conversationId: "conv-1",
    });
    expect(escalation.subject).toContain("نور");
    expect(escalation.text).toContain("أريد التحدث مع شخص");
    expect(escalation.text).toContain("noor@example.test");

    // The registry used by /api/email/send resolves the same templates.
    expect(renderEmailTemplate("welcome", { name: "نور" }).subject).toContain("نور");
    expect(() => renderEmailTemplate("invoice", { name: "نور" })).toThrow(/number/i);
    expect(() => renderEmailTemplate("invoice", { name: "نور", number: "INV-1" })).toThrow(/amount/i);
  });

  it("sends through Resend when RESEND_API_KEY is configured", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_unit_test_key");
    vi.stubEnv("EMAIL_FROM", "no-reply@ofoq.test");
    vi.stubEnv("EMAIL_FROM_NAME", "أفق | Ofoq");
    const fetchMock = vi.fn().mockResolvedValue(RESEND_OK());
    vi.stubGlobal("fetch", fetchMock);

    expect(emailStatus()).toMatchObject({ provider: "resend", configured: true });

    const result = await sendTemplateEmail("client@example.test", welcomeTemplate("نور"));

    expect(result).toEqual({
      delivered: true,
      provider: "resend",
      id: "e2e-test-email-id",
      to: ["client@example.test"],
      subject: expect.stringContaining("نور"),
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(callUrl(fetchMock, 0)).toContain("api.resend.com");

    expect(callHeaders(fetchMock, 0).authorization).toBe("Bearer re_unit_test_key");
    const body = callBody(fetchMock, 0);
    expect(body.from).toBe("أفق | Ofoq <no-reply@ofoq.test>");
    expect(body.to).toEqual(["client@example.test"]);
    expect(String(body.subject)).toContain("نور");

    // Invalid input is refused before any network call is attempted.
    const invalid = await sendEmail({ to: "not-an-email", subject: "x", text: "y" });
    expect(invalid.delivered).toBe(false);
    expect(invalid.error).toMatch(/recipient/i);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("never throws when RESEND_API_KEY is missing: it renders and falls back to the console transport", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(emailStatus()).toMatchObject({ provider: "console", configured: false });

    const result = await sendEmail({
      to: "client@example.test",
      subject: "أهلًا بك في أفق",
      text: "نص الرسالة",
      html: "<p>نص الرسالة</p>",
    });

    expect(result).toEqual({
      delivered: false,
      provider: "console",
      id: null,
      to: ["client@example.test"],
      subject: "أهلًا بك في أفق",
    });
    expect(fetchMock).not.toHaveBeenCalled();

    // A Resend rejection is reported, not thrown.
    vi.stubEnv("RESEND_API_KEY", "re_unit_test_key");
    const rejecting = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ statusCode: 422, name: "validation_error", message: "Invalid `from`" }), {
        status: 422,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", rejecting);

    const rejected = await sendEmail({
      to: "client@example.test",
      subject: "فاتورة",
      text: "…",
    });
    expect(rejected.delivered).toBe(false);
    expect(rejected.provider).toBe("resend");
    expect(rejected.error).toBeTruthy();
  });
});
