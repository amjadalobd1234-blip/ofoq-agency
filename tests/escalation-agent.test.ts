import { describe, expect, it } from "vitest";

import {
  ESCALATION_TITLES,
  analyseLead,
  detectEscalation,
  escalationAlertPayload,
  handoffNotice,
  summariseConversation,
} from "../src/lib/agents/escalation-agent";

/**
 * Business rule under test: an escalation is never just a sentence.
 *
 * The assistant used to tell the client "your request will be handed to the
 * team" while nothing was recorded. These tests pin the detection that turns
 * that sentence into an `alerts` row, so the promise and the platform state
 * cannot drift apart again.
 */
describe("escalation agent detection", () => {
  it("raises an urgent human handoff when the client asks for a person", () => {
    const decision = detectEscalation({ latestMessage: "أريد أتكلم مع بشري" });

    expect(decision.escalate).toBe(true);
    expect(decision.category).toBe("HUMAN_REQUEST");
    expect(decision.severity).toBe("URGENT");
    expect(decision.signals).toContain("client_asked_for_human");
    expect(decision.reasonAr).toContain("فريق بشري");
  });

  it("detects the same request in English, and a complaint in Arabic", () => {
    expect(detectEscalation({ latestMessage: "I want to talk to a real person, please call me" })).toMatchObject({
      escalate: true,
      category: "HUMAN_REQUEST",
      severity: "URGENT",
    });

    expect(detectEscalation({ latestMessage: "أنا غير راضي عن الخدمة، هذه شكوى" })).toMatchObject({
      escalate: true,
      category: "HUMAN_REQUEST",
      severity: "URGENT",
      signals: expect.arrayContaining(["client_complaint"]),
    });
  });

  it("honours a handoff the assistant promised in its own reply", () => {
    // The reported bug: the reply said it, the platform did not do it.
    const decision = detectEscalation({
      latestMessage: "ممكن تساعدني بالخطة؟",
      assistantReply: "طلبك غير اعتيادي، لذلك سيتم تحويل طلبك للفريق وسيتواصل معك أحدهم.",
    });

    expect(decision.escalate).toBe(true);
    expect(decision.category).toBe("HUMAN_REQUEST");
    expect(decision.signals).toContain("assistant_promised_handoff");
  });

  it("raises a NEW_LEAD once the client's need is understood", () => {
    const decision = detectEscalation({
      latestMessage: "الميزانية 500 دولار والشغل خلال شهر",
      history: [{ role: "user", content: "أريد إدارة حسابات التواصل الاجتماعي على إنستغرام" }],
    });

    expect(decision).toMatchObject({ escalate: true, category: "NEW_LEAD", severity: "IMPORTANT" });
    expect(decision.reasonAr).toContain("اكتمل فهم الاحتياج");
    expect(decision.signals.join(",")).toContain("service:");
  });

  it("does not escalate a greeting or a bare question", () => {
    expect(detectEscalation({ latestMessage: "مرحبا" }).escalate).toBe(false);
    expect(detectEscalation({ latestMessage: "ماذا تقدمون؟" }).escalate).toBe(false);
    // A service with no scope yet is still a conversation, not a lead.
    expect(detectEscalation({ latestMessage: "أريد تسويق لنشاطي" }).escalate).toBe(false);
  });

  it("reads the brief facts out of the conversation", () => {
    const lead = analyseLead({
      latestMessage: "15 منشور خلال أسبوعين",
      history: [{ role: "user", content: "أحتاج موقع إلكتروني ومتجر" }],
    });

    expect(lead.complete).toBe(true);
    expect(lead.facts.postCount).toBe(15);
    expect(lead.facts.timelineDays).toBe(14);
    expect(lead.factsAr.join(" ")).toContain("المدة");
  });
});

describe("escalation alert payload", () => {
  it("writes the alert row the admin dashboard and the owner email expect", () => {
    const decision = detectEscalation({ latestMessage: "أريد أتكلم مع بشري" });
    const summary = summariseConversation({
      history: [{ role: "user", content: "أحتاج حملة إعلانية لمتجري" }],
      latestMessage: "أريد أتكلم مع بشري",
      locale: "ar",
    });
    const payload = escalationAlertPayload(decision, summary);

    expect(payload).toMatchObject({
      severity: "URGENT",
      category: "HUMAN_REQUEST",
      title_ar: ESCALATION_TITLES.ar,
      title_en: ESCALATION_TITLES.en,
      entity_type: "conversation",
      target_role: "ANY_STAFF",
    });
    expect(payload.title_ar).toBe("عميل جديد يطلب تواصل");
    expect(payload.title_en).toBe("New client requesting contact");
    // The client's own words reach the team, in both languages' bodies.
    expect(payload.body_ar).toContain("أريد أتكلم مع بشري");
    expect(payload.body_en).toContain("Human handoff");
    expect(payload.body_en).toContain("أريد أتكلم مع بشري");
    expect(payload.meta.source).toBe("escalation-agent");
  });

  it("keeps the summary inside the column limits", () => {
    const long = "أ".repeat(4_000);
    const summary = summariseConversation({ latestMessage: long, history: [] });
    expect(summary.ar.length).toBeLessThanOrEqual(1_500);
    expect(summary.en.length).toBeLessThanOrEqual(1_500);
    expect(summary.clientLines).toHaveLength(1);
  });
});

describe("what the client is told", () => {
  it("promises a follow-up only in the confirmed wording", () => {
    expect(handoffNotice("ar", "confirmed")).toContain("تم تحويل محادثتك");
    expect(handoffNotice("en", "confirmed")).toContain("handed over");
    // The failure wording must not claim the team was notified.
    expect(handoffNotice("ar", "failed")).not.toContain("تم تحويل");
    expect(handoffNotice("ar", "failed")).toContain("تعذّر");
    expect(handoffNotice("en", "failed")).not.toContain("handed over");
  });
});
