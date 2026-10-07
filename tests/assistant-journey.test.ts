import { beforeAll, describe, expect, it } from "vitest";

import { createCustomer, findCustomerById, factsToMap } from "../src/lib/repositories/customers.repo";
import { registerClient } from "../src/lib/services/identity.service";
import { sendClientMessage, bootstrapAssistant } from "../src/lib/services/assistant.service";
import { listCustomerOffers } from "../src/lib/services/offers.service";
import { listCustomerProjects } from "../src/lib/services/projects.service";
import { listAgentActions, listAgentRuns } from "../src/lib/repositories/agents.repo";
import { getDb } from "../src/lib/db";

/**
 * End-to-end journey test: this is the behaviour the business rules require from
 * "مساعد أفق" — greet, understand the need with only the necessary questions,
 * summarise and confirm, then produce a priced offer plus a project with a plan.
 */
describe("assistant client journey", () => {
  let customerId = "";
  let userId = "";

  beforeAll(async () => {
    const email = `journey-${Date.now()}@example.test`;
    const { user } = await registerClient({
      email,
      password: "Password123",
      name: "Journey Client",
      locale: "ar",
      country: "IQ",
    });
    userId = user.id;
    const customer = await createCustomer({
      user_id: user.id,
      contact_name: "Journey Client",
      email,
      locale: "ar",
      currency: "USD",
      country: "IQ",
      status: "ACTIVE",
    });
    customerId = customer.id;
  });

  it("opens the conversation with a greeting instead of a long form", async () => {
    const bootstrap = await bootstrapAssistant(customerId);
    expect(bootstrap.messages.length).toBeGreaterThan(0);
    expect(bootstrap.messages[0]!.sender).toBe("ASSISTANT");
    expect(bootstrap.messages[0]!.body).toContain("أفق");
    // The assistant is always disclosed as an AI assistant of the agency.
    expect(bootstrap.disclosure).toContain("ذكي");
    expect(bootstrap.quickReplies.length).toBeGreaterThan(0);
  });

  it("collects the requirement one question at a time and records sourced facts", async () => {
    const first = await sendClientMessage({
      customerId,
      body: "أريد إدارة حسابات التواصل الاجتماعي وإنستغرام وفيسبوك، ١٥ منشورًا شهريًا",
      userId,
    });
    // It must ask for the next missing piece rather than dumping every question.
    expect(first.reply.body.length).toBeGreaterThan(10);
    expect(first.stage === "COLLECTING" || first.stage === "CONFIRMING").toBe(true);

    const facts = await factsToMap(customerId);
    expect(facts.services).toContain("social-media-management");
    expect(facts.platforms).toContain("instagram");
    expect(facts.volume).toBe("15");

    // Provenance is recorded for every fact.
    const rows = await getDb().then((db) =>
      db.query<{ source: string; fact_key: string }>(
        "SELECT source, fact_key FROM customer_facts WHERE customer_id = ?",
        [customerId],
      ),
    );
    expect(rows.every((row) => ["CHAT", "FORM", "AGENT", "STAFF", "IMPORT"].includes(row.source))).toBe(true);
  });

  it("uses plain Arabic and asks about budget without inventing one", async () => {
    const second = await sendClientMessage({
      customerId,
      body: "ميزانيتي غير محددة",
      userId,
    });
    expect(second.reply.language).toBe("ar");
    const facts = await factsToMap(customerId);
    // "not sure" is recorded as an explicit skip, never as a guessed number.
    expect(facts.budget_max_minor).toBeUndefined();
    expect(facts.skipped_slots ?? "").toContain("budget");
  });

  it("summarises, then creates an offer and a project once confirmed", async () => {
    // Provide the remaining slots the assistant asked about.
    await sendClientMessage({ customerId, body: "أريد زيادة الطلبات، الموعد خلال 30 يوم", userId });
    const summary = await sendClientMessage({ customerId, body: "نعم، صحيح", userId });

    expect(summary.stage).toBe("QUOTED");

    const offers = await listCustomerOffers(customerId);
    expect(offers.total).toBe(1);
    const offer = offers.rows[0]!;
    expect(offer.total_minor).toBeGreaterThan(0);
    expect(offer.items.length).toBeGreaterThan(0);
    // The pricing reason must be stored with the offer.
    expect(offer.pricing_reason).toBeTruthy();
    expect(offer.created_by_agent).toBe("proposal_writer");

    const projects = await listCustomerProjects(customerId);
    expect(projects.total).toBeGreaterThanOrEqual(1);
    const project = projects.rows[0]!;
    expect(project.ai_plan).toBeTruthy();

    // A plan exists with client-visible tasks, and progress starts at 0.
    const tasks = await getDb().then((db) =>
      db.query<{ visibility: string }>("SELECT visibility FROM project_tasks WHERE project_id = ?", [project.id]),
    );
    expect(tasks.length).toBeGreaterThan(0);
    expect(tasks.some((task) => task.visibility === "CLIENT")).toBe(true);
  });

  it("answers status questions from the client's own data only", async () => {
    const reply = await sendClientMessage({ customerId, body: "حالة مشاريعي", userId });
    expect(reply.reply.body).toMatch(/OFQ-P-/);
  });

  it("escalates a complaint to the human team", async () => {
    const reply = await sendClientMessage({
      customerId,
      body: "أنا غير راضي عن الخدمة وأريد التحدث مع مسؤول",
      userId,
    });
    expect(reply.escalated).toBe(true);
    expect(reply.reply.body).toMatch(/فريق|بشري|مسؤول/);
  });

  it("records every agent run and action for the audit trail", async () => {
    const runs = await listAgentRuns({ customerId });
    expect(runs.total).toBeGreaterThan(0);
    const actions = await listAgentActions({ customerId });
    expect(actions.total).toBeGreaterThan(0);
    const orchestrator = runs.rows.find((run) => run.agent_key === "orchestrator");
    expect(orchestrator).toBeTruthy();
  });

  it("keeps the conversation history in the client file with its channel", async () => {
    const rows = await getDb().then((db) =>
      db.query<{ channel: string; sender_type: string }>(
        `SELECT v.channel AS channel, m.sender_type AS sender_type
         FROM messages m JOIN conversations v ON v.id = m.conversation_id
         WHERE v.customer_id = ?`,
        [customerId],
      ),
    );
    expect(rows.length).toBeGreaterThan(4);
    expect(rows.every((row) => row.channel === "WEB")).toBe(true);
    expect(rows.some((row) => row.sender_type === "CLIENT")).toBe(true);
    expect(rows.some((row) => row.sender_type === "ASSISTANT")).toBe(true);
  });

  it("never leaks internal pricing data into the assistant reply", async () => {
    const customer = await findCustomerById(customerId);
    expect(customer).toBeTruthy();
    const reply = await sendClientMessage({ customerId, body: "كم سعر إدارة الإعلانات؟", userId });
    expect(reply.reply.body).not.toMatch(/هامش|margin|تكلفة داخلية|internal cost/i);
  });
});
