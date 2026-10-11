import { describe, expect, it } from "vitest";

import { detectEscalation } from "../src/lib/agents/escalation-agent";

/**
 * Regression: "أريد بشر" never escalated, so raiseClientEscalation was not
 * called and no alert row was written. Pure detection, no database.
 */
describe("human-request detection (Arabic + English)", () => {
  const asksForHuman = [
    "أريد بشر",
    "اريد بشر",
    "ابغى بشر",
    "أريد البشر",
    "أريد التحدث مع شخص",
    "أبغى أتكلم مع موظف",
    "ابي واحد من الفريق",
    "I want a human",
    "please connect me to a real person",
  ];
  const doesNotAsk = ["أريد تصميم شعار", "كم سعر الفيديو؟", "شكراً جزيلاً"];

  for (const message of asksForHuman) {
    it(`escalates: ${message}`, () => {
      const decision = detectEscalation({ latestMessage: message, history: [] });
      expect(decision.escalate).toBe(true);
      expect(decision.category).toBe("HUMAN_REQUEST");
      expect(decision.severity).toBe("URGENT");
    });
  }

  for (const message of doesNotAsk) {
    it(`does not escalate: ${message}`, () => {
      expect(detectEscalation({ latestMessage: message, history: [] }).escalate).toBe(false);
    });
  }
});
