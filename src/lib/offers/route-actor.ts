import {
  resolveRouteActor,
  routeErrorResponse,
  routeUnauthenticated,
  type RouteActor,
} from "@/lib/auth/route-actor";

/**
 * The Offers API route guard.
 *
 * The logic now lives in `@/lib/auth/route-actor` so every platform API
 * (offers, projects) resolves the caller in exactly the same way; these
 * exports keep the offers routes unchanged.
 */

/** Maps service-layer errors to the API's JSON shape; internals never leak. */
export function offersErrorResponse(error: unknown): Response {
  return routeErrorResponse(error, "offers-api");
}

export const offersUnauthenticated = () => routeUnauthenticated();

export type OffersRouteActor = RouteActor;

export async function resolveOffersActor(request: Request): Promise<OffersRouteActor | null> {
  return resolveRouteActor(request);
}
