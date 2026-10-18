import { beforeAll, describe, expect, it } from "vitest";

import { createFormalOfferDraft } from "../src/lib/agents/specialists/offers.agent";
import { priceRequirements } from "../src/lib/agents/specialists/pricing.agent";
import type { RequirementProfile } from "../src/lib/agents/specialists/needs.agent";
import type { Actor } from "../src/lib/auth/permissions";
import { createCustomer } from "../src/lib/repositories/customers.repo";
import { createUser } from "../src/lib/repositories/identity.repo";
import { updateOffer } from "../src/lib/repositories/offers.repo";
import {
  approveAndSendOffer,
  approveOffer,
  getOfferForActor,
  rejectOffer,
  updateDraftOffer,
} from "../src/lib/services/offers.service";
import type { CustomerRow } from "../src/lib/domain/types";

/**
 * Offers Agent v1: draft-only creation from Pricing Agent prices, owner
 * approval before sending, client-only accept/reject, strict isolation.
 */
describe("offers agent", () => {
  let customer: CustomerRow;
  let otherCustomer: CustomerRow;
  let owner: Actor;
  let client: Actor;
  let otherClient: Actor;

  const profile: RequirementProfile = {
    customerId: "", locale: "ar", goal: "زيادة الطلبات", services: ["social-media-management"],
    platforms: ["instagram"], volume: 10, timelineDays: 30, budgetMaxMinor: null,
    budgetCurrency: "USD", country: "IQ", marketCountries: ["IQ"], notes: [],
    completeness: 80, missing: [], skipped: [],
  };

  beforeAll(async () => {
    const ownerUser = await createUser({ email: "offers-owner@example.test", name: "Owner", role: "OWNER" });
    owner = { id: ownerUser.id, role: "OWNER" };
    const clientUser = await createUser({ email: "offers-client@example.test", name: "Client", role: "CLIENT" });
    const otherUser = await createUser({ email: "offers-other@example.test", name: "Other", role: "CLIENT" });
    customer = await createCustomer({ user_id: clientUser.id, contact_name: "Client", email: clientUser.email, locale: "ar", currency: "USD", country: "IQ", status: "ACTIVE" });
    otherCustomer = await createCustomer({ user_id: otherUser.id, contact_name: "Other", email: otherUser.email, locale: "ar", currency: "USD", country: "IQ", status: "ACTIVE" });
    client = { id: clientUser.id, role: "CLIENT", customerId: customer.id };
    otherClient = { id: otherUser.id, role: "CLIENT", customerId: otherCustomer.id };
    profile.customerId = customer.id;
  });

  async function draft() {
    return createFormalOfferDraft({ customer, profile, locale: "ar" });
  }

  it("creates a numbered DRAFT in USD priced only by the pricing agent, with terms and expiry", async () => {
    const expected = await priceRequirements(customer, profile);
    const { offer, clientView, sentToClient, requiresOwnerApproval } = await draft();

    expect(offer.code).toMatch(/^OFOQ-\d{4}-\d{3,}$/);
    expect(offer.status).toBe("DRAFT");
    expect(sentToClient).toBe(false);
    expect(requiresOwnerApproval).toBe(true);
    expect(offer.currency).toBe("USD");
    expect(offer.created_by_agent).toBe("offers");
    // No invented prices: totals and items equal the pricing agent's quote.
    expect(offer.total_minor).toBe(expected.quote.totalMinor);
    expect(offer.items.length).toBeGreaterThan(0);
    expect(offer.items.reduce((sum, item) => sum + item.total_minor, 0)).toBe(expected.quote.subtotalMinor);
    // Terms + expiry are attached.
    expect(offer.client_note).toContain("USD");
    expect(offer.client_note).toContain("صالح حتى");
    expect(offer.valid_until).toBeTruthy();
    expect(new Date(offer.valid_until!).getTime()).toBeGreaterThan(Date.now());
    // Client view never leaks internal data.
    expect(clientView.code).toBe(offer.code);
    expect(clientView.canApprove).toBe(false);
    expect(JSON.stringify(clientView)).not.toContain("internal_cost");
    expect(JSON.stringify(clientView)).not.toContain("margin");
    expect(JSON.stringify(clientView)).not.toContain("internal_note");
  });

  it("issues unique consecutive offer codes", async () => {
    const a = await draft();
    const b = await draft();
    expect(a.offer.code).not.toBe(b.offer.code);
    const seq = (code: string) => Number(code.split("-").at(-1));
    expect(seq(b.offer.code)).toBe(seq(a.offer.code) + 1);
  });

  it("blocks clients from seeing drafts, sending, editing or accepting a draft", async () => {
    const { offer } = await draft();
    await expect(getOfferForActor(offer.id, client)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(approveAndSendOffer(offer.id, client)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(updateDraftOffer(offer.id, client, { clientNote: "x" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(approveOffer(offer.id, client)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(rejectOffer(offer.id, client)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("lets the owner edit a draft (repriced from the catalogue) then approve and send it", async () => {
    const { offer } = await draft();
    const edited = await updateDraftOffer(offer.id, owner, {
      lines: [{ serviceSlug: "consulting", quantity: 1 }],
      validForDays: 7,
    });
    expect(edited.status).toBe("DRAFT");
    expect(edited.items).toHaveLength(1);
    expect(edited.total_minor).toBe(edited.items[0]!.total_minor);
    expect(edited.total_minor).toBeGreaterThan(0);
    await expect(updateDraftOffer(offer.id, owner, { lines: [{ serviceSlug: "no-such-service" }] }))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const sent = await approveAndSendOffer(offer.id, owner);
    expect(sent.status).toBe("SENT");
    // No second send, no editing after send.
    await expect(approveAndSendOffer(offer.id, owner)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(updateDraftOffer(offer.id, owner, { clientNote: "late" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("only the owning client can accept a sent offer; acceptance issues an invoice", async () => {
    const { offer } = await draft();
    await approveAndSendOffer(offer.id, owner);
    await expect(approveOffer(offer.id, otherClient)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(approveOffer(offer.id, owner)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    const decision = await approveOffer(offer.id, client);
    expect(decision.offer.status).toBe("APPROVED");
    expect(decision.invoiceId).toBeTruthy();
  });

  it("only the owning client can reject a sent offer, once", async () => {
    const { offer } = await draft();
    await approveAndSendOffer(offer.id, owner);
    await expect(rejectOffer(offer.id, otherClient)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const rejected = await rejectOffer(offer.id, client, "خارج الميزانية");
    expect(rejected.status).toBe("REJECTED");
    await expect(rejectOffer(offer.id, client)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(approveOffer(offer.id, client)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("does not send or accept an expired offer", async () => {
    const { offer } = await draft();
    await updateOffer(offer.id, { valid_until: new Date(Date.now() - 1_000).toISOString() });
    await expect(approveAndSendOffer(offer.id, owner)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    const second = await draft();
    await approveAndSendOffer(second.offer.id, owner);
    await updateOffer(second.offer.id, { valid_until: new Date(Date.now() - 1_000).toISOString() });
    await expect(approveOffer(second.offer.id, client)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect((await getOfferForActor(second.offer.id, owner)).status).toBe("EXPIRED");
  });
});
