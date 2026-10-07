import { beforeAll, describe, expect, it } from "vitest";

import { getDb } from "../src/lib/db";
import { createCustomer } from "../src/lib/repositories/customers.repo";
import { registerClient } from "../src/lib/services/identity.service";
import { bootstrapAssistant, sendClientMessage } from "../src/lib/services/assistant.service";
import { listCustomerOffers } from "../src/lib/services/offers.service";
import { listCustomerProjects } from "../src/lib/services/projects.service";

/**
 * Business rule under test: the assistant may price ordinary requests by itself,
 * but an unusual case (here: a budget far below the service floor) must NEVER be
 * approved silently. It has to stop, keep the offer out of the client's hands,
 * record the reason and ask a human to decide.
 */
describe("assistant escalation rules", () => {
  let customerId = "";
  let userId = "";

  beforeAll(async () => {
    const email = `escalate-${Date.now()}@example.test`;
    const { user } = await registerClient({ email, password: "Password123", name: "Escalation Client", locale: "ar" });
    userId = user.id;
    const customer = await createCustomer({
      user_id: user.id,
      contact_name: "Escalation Client",
      email,
      locale: "ar",
      currency: "USD",
      country: "IQ",
      status: "ACTIVE",
    });
    customerId = customer.id;
    await bootstrapAssistant(customerId);
  });

  it("does not send an offer the agency would lose money on", async () => {
    await sendClientMessage({
      customerId,
      body: "أريد إدارة حسابات التواصل الاجتماعي على إنستغرام وفيسبوك، ١٥ منشورًا، الموعد خلال 30 يوم",
      userId,
    });
    await sendClientMessage({ customerId, body: "ميزانيتي 20 دولار فقط", userId });
    const confirmation = await sendClientMessage({ customerId, body: "نعم، صحيح", userId });

    // Stage stays at CONFIRMING: the client has not been given an approvable offer.
    expect(confirmation.stage).toBe("CONFIRMING");
    expect(confirmation.escalated).toBe(true);
    expect(confirmation.reply.body).toMatch(/مراجعة|فريقنا/);

    const offers = await listCustomerOffers(customerId);
    expect(offers.total).toBe(1);
    const offer = offers.rows[0]!;
    // Created for the record, but NOT sent/approvable for the client.
    expect(offer.status).not.toBe("SENT");
    expect(offer.status).not.toBe("APPROVED");

    // The reason is stored with the price, not lost.
    expect(offer.pricing_reason ?? "").toMatch(/escalation:(above_budget|below_floor|large_discount|thin_margin)/);

    const projects = await listCustomerProjects(customerId);
    expect(projects.total).toBeGreaterThanOrEqual(1);
    expect(projects.rows[0]!.status).not.toBe("IN_PROGRESS");
  });

  it("raises a staff alert carrying the reason", async () => {
    const alerts = await getDb().then((db) =>
      db.query<{ severity: string; resolved_at: string | null; body_ar: string | null; dedupe_key: string | null }>(
        "SELECT severity, resolved_at, body_ar, dedupe_key FROM alerts WHERE customer_id = ? ORDER BY created_at DESC",
        [customerId],
      ),
    );
    expect(alerts.length).toBeGreaterThan(0);
    const open = alerts.filter((alert) => alert.resolved_at === null);
    expect(open.length).toBeGreaterThan(0);
    expect(open.some((alert) => alert.severity === "IMPORTANT" || alert.severity === "URGENT")).toBe(true);
  });

  it("records the escalation as an agent action needing approval", async () => {
    const rows = await getDb().then((db) =>
      db.query<{ requires_approval: number; risk_level: string; action: string }>(
        `SELECT a.requires_approval, a.risk_level, a.action
         FROM agent_actions a JOIN agent_runs r ON r.id = a.agent_run_id
         WHERE r.customer_id = ?`,
        [customerId],
      ),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((row) => row.requires_approval === 1)).toBe(true);
  });

  it("never blocks the client: it answers a question and repeats the pending step", async () => {
    const reply = await sendClientMessage({ customerId, body: "لماذا؟", userId });
    // The client is told a human is reviewing, and still gets the summary + confirm step.
    expect(reply.reply.body).toMatch(/فريقنا|مراجعة/);
    expect(reply.reply.body).toMatch(/ملخص/);
    expect(reply.stage).toBe("CONFIRMING");
  });
});
