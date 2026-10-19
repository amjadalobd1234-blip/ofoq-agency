import { AppError } from "@/lib/core/errors";
import type { Actor } from "@/lib/auth/permissions";
import { getCurrentSession } from "@/lib/auth/session";
import type { CustomerRow } from "@/lib/domain/types";
import { findCustomerByUserId } from "@/lib/repositories/customers.repo";
import { findUserById } from "@/lib/repositories/identity.repo";
import { getSupabaseConfig } from "@/lib/supabase/config";
import { fetchOwnProfile, requireSupabaseUser } from "@/lib/supabase/route-auth";

/**
 * The shared route guard for the platform APIs.
 *
 * Two session systems exist in the repo and both end at the same
 * `public.users` / `public.customers` rows, so both are accepted:
 *   1. the Supabase Auth session used by the live site (profile role +
 *      customer link read from the platform tables), and
 *   2. the platform's own session cookie (local/self-hosted runs and tests).
 *
 * Returns null when there is no usable session — the route answers 401.
 * Authorization itself is NOT decided here: every service function re-checks
 * the role and the customer ownership before touching data.
 */
export interface RouteActor {
  actor: Actor;
  customer: CustomerRow | null;
}

export async function resolveRouteActor(request: Request): Promise<RouteActor | null> {
  if (getSupabaseConfig()) {
    const auth = await requireSupabaseUser(request);
    if (!auth.response) {
      const { profile } = await fetchOwnProfile(auth.client, auth.user.id);
      if (profile && profile.status === "ACTIVE") {
        const customer =
          profile.role === "CLIENT" ? ((await findCustomerByUserId(profile.id)) ?? null) : null;
        return { actor: { id: profile.id, role: profile.role, customerId: customer?.id ?? null }, customer };
      }
      return null;
    }
  }

  const session = await getCurrentSession().catch(() => null);
  if (!session) return null;
  const user = await findUserById(session.user_id);
  if (!user || user.status !== "ACTIVE") return null;
  const customer = user.role === "CLIENT" ? ((await findCustomerByUserId(user.id)) ?? null) : null;
  return { actor: { id: user.id, role: user.role, customerId: customer?.id ?? null }, customer };
}

/** Maps service-layer errors to the API's JSON shape; internals never leak. */
export function routeErrorResponse(error: unknown, scope = "api"): Response {
  if (error instanceof AppError) {
    return Response.json(
      { error: error.message, code: error.code },
      { status: error.status, headers: { "Cache-Control": "no-store" } },
    );
  }
  // eslint-disable-next-line no-console
  console.error(`[${scope}] unexpected failure`, error instanceof Error ? error.message : String(error));
  return Response.json(
    { error: "The request could not be completed.", code: "INTERNAL" },
    { status: 500, headers: { "Cache-Control": "no-store" } },
  );
}

export const routeUnauthenticated = () =>
  Response.json(
    { error: "Authentication required.", code: "UNAUTHENTICATED" },
    { status: 401, headers: { "Cache-Control": "no-store" } },
  );
