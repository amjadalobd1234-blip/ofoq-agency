import { z } from "zod";

import { createFormalOfferDraft } from "@/lib/agents/specialists/offers.agent";
import type { RequirementProfile } from "@/lib/agents/specialists/needs.agent";
import { isStaff } from "@/lib/auth/permissions";
import { ValidationError } from "@/lib/core/errors";
import { offersErrorResponse, offersUnauthenticated, resolveOffersActor } from "@/lib/offers/route-actor";
import { findCustomerById } from "@/lib/repositories/customers.repo";
import { listOffers } from "@/lib/repositories/offers.repo";
import { toClientOfferView } from "@/lib/services/offers.service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const createSchema = z.object({
  services: z.array(z.string().trim().min(1)).min(1).max(10),
  goal: z.string().trim().max(500).optional(),
  platforms: z.array(z.string().trim().min(1)).max(10).optional(),
  volume: z.number().int().positive().max(10_000).optional(),
  timelineDays: z.number().int().positive().max(3650).optional(),
  validForDays: z.number().int().positive().max(365).optional(),
  /** Staff only: create the draft for this customer. Ignored for clients. */
  customerId: z.string().trim().min(1).optional(),
});

/**
 * POST /api/offers — the client asks for a formal offer.
 * Creates a DRAFT only (Offers Agent, pricing-agent prices). It is never
 * sent here: owner/partner approval is a separate, staff-only step.
 *
 * GET /api/offers — staff see recent offers in full; a client sees only
 * their own published (non-draft) offers, in the client-safe view.
 */
export async function POST(request: Request) {
  try {
    const resolved = await resolveOffersActor(request);
    if (!resolved) return offersUnauthenticated();
    const body = await request.json().catch(() => null);
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError("Invalid offer request", { issues: parsed.error.issues.length });

    const customer = isStaff(resolved.actor)
      ? parsed.data.customerId
        ? await findCustomerById(parsed.data.customerId)
        : null
      : resolved.customer;
    if (!customer) {
      throw new ValidationError(
        isStaff(resolved.actor) ? "customerId of an existing customer is required" : "No customer profile is linked to this account",
        { field: "customerId" },
      );
    }

    const profile: RequirementProfile = {
      customerId: customer.id,
      locale: customer.locale,
      goal: parsed.data.goal ?? null,
      services: parsed.data.services,
      platforms: parsed.data.platforms ?? [],
      volume: parsed.data.volume ?? null,
      timelineDays: parsed.data.timelineDays ?? null,
      budgetMaxMinor: null,
      budgetCurrency: "USD",
      country: customer.country,
      marketCountries: customer.country ? [customer.country] : [],
      notes: [],
      completeness: 0,
      missing: [],
      skipped: [],
    };

    const result = await createFormalOfferDraft({
      customer,
      profile,
      locale: customer.locale,
      validForDays: parsed.data.validForDays,
      createdByUserId: resolved.actor.id,
    });
    // Clients receive the safe view; staff creating for a client get it too —
    // internal figures are read through GET /api/offers/[id] as staff.
    return Response.json(
      { data: { ...result.clientView, status: result.offer.status, requiresOwnerApproval: true } },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return offersErrorResponse(error);
  }
}

export async function GET(request: Request) {
  try {
    const resolved = await resolveOffersActor(request);
    if (!resolved) return offersUnauthenticated();
    const url = new URL(request.url);
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 20));

    if (isStaff(resolved.actor)) {
      const { rows, total } = await listOffers({ limit });
      return Response.json({ data: { rows, total } }, { headers: { "Cache-Control": "no-store" } });
    }
    if (!resolved.customer) throw new ValidationError("No customer profile is linked to this account");
    const { rows, total } = await listOffers({ customerId: resolved.customer.id, limit });
    const published = rows.filter((offer) => offer.status !== "DRAFT");
    const views = await Promise.all(published.map((offer) => toClientOfferView(offer, resolved.customer!.locale)));
    return Response.json({ data: { rows: views, total } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return offersErrorResponse(error);
  }
}
