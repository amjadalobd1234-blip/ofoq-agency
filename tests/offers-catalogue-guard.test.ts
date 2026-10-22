import { beforeAll, describe, expect, it } from "vitest";

import { createFormalOfferDraft } from "../src/lib/agents/specialists/offers.agent";
import type { RequirementProfile } from "../src/lib/agents/specialists/needs.agent";
import type { Actor } from "../src/lib/auth/permissions";
import type { CustomerRow } from "../src/lib/domain/types";
import { createCustomer } from "../src/lib/repositories/customers.repo";
import { createUser } from "../src/lib/repositories/identity.repo";
import { listOffers, updateOffer } from "../src/lib/repositories/offers.repo";
import { approveAndSendOffer, approveOffer } from "../src/lib/services/offers.service";
import { testDriver } from "./setup";

/**
 * Guards against a zero-value "official" offer.
 *
 * On a deployment whose service catalogue was never seeded (the tables exist,
 * `services` is empty) the pricing agent returns an empty quote. Before these
 * guards the Offers Agent still produced a numbered DRAFT with total 0 and no
 * line items, the owner could send it and the client could accept it — a $0
 * offer published as official. The two guards under test:
 *
 *   1. `createFormalOfferDraft` fails closed when there is no active service to
 *      price against (a deployment/configuration problem, not a quote);
 *   2. `assertPriced` refuses to send/accept any offer whose total is not
 *      positive, so a row that already carries 0 cannot reach the client.
 */
describe("offers agent — no zero-value official offers", () => {
  let customer: CustomerRow;
  let owner: Actor;
  let client: Actor;

  const profile: RequirementProfile = {
    customerId: "",
    locale: "ar",
    goal: "leads",
    services: ["paid-ads"],
    platforms: ["instagram"],
    volume: 1,
    timelineDays: 30,
    budgetMaxMinor: null,
    budgetCurrency: "USD",
    country: "IQ",
    marketCountries: ["IQ"],
    notes: [],
    completeness: 60,
    missing: [],
    skipped: [],
  };

  beforeAll(async () => {
    const ownerUser = await createUser({ email: "guard-owner@example.test", name: "Owner", role: "OWNER" });
    owner = { id: ownerUser.id, role: "OWNER" };
    const clientUser = await createUser({ email: "guard-client@example.test", name: "Client", role: "CLIENT" });
    customer = await createCustomer({
      user_id: clientUser.id,
      contact_name: "Client",
      email: clientUser.email,
      locale: "ar",
      currency: "USD",
      country: "IQ",
      status: "ACTIVE",
    });
    client = { id: clientUser.id, role: "CLIENT", customerId: customer.id };
    profile.customerId = customer.id;
  });

  it("refuses to create an offer draft when the catalogue has no active service", async () => {
    // Simulates the production state the setup SQL leaves behind: the tables
    // exist but `npm run db:seed` was never run against that database.
    await testDriver().run("UPDATE services SET is_active = 0");
    try {
      await expect(createFormalOfferDraft({ customer, profile, locale: "ar" })).rejects.toMatchObject({
        code: "CONFIGURATION_ERROR",
      });
      const { rows } = await listOffers({ customerId: customer.id });
      expect(rows).toHaveLength(0);
    } finally {
      await testDriver().run("UPDATE services SET is_active = 1");
    }
  });

  it("still creates a priced draft once the catalogue is active", async () => {
    const { offer } = await createFormalOfferDraft({ customer, profile, locale: "ar" });
    expect(offer.total_minor).toBeGreaterThan(0);
    expect(offer.items.length).toBeGreaterThan(0);
  });

  it("refuses to send a legacy draft whose total is 0 and the client cannot accept it", async () => {
    const { offer } = await createFormalOfferDraft({ customer, profile, locale: "ar" });
    // A row written before the guard existed (or by any other path) with 0.
    const zeroed = await updateOffer(offer.id, { subtotal_minor: 0, total_minor: 0 });
    expect(zeroed?.total_minor).toBe(0);

    await expect(approveAndSendOffer(offer.id, owner)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });

    // Even if the status is forced to SENT, the client's acceptance is refused.
    await updateOffer(offer.id, { status: "SENT" });
    await expect(approveOffer(offer.id, client)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
  });
});
