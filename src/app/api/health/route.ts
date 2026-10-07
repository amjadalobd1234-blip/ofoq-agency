import { checkDbHealth } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A small, unauthenticated probe for Vercel and uptime monitors. */
export async function GET(): Promise<Response> {
  const health = await checkDbHealth();
  const ok = health.ok;

  // Keep credentials, connection targets, and database error details out of the
  // public health response. The detailed diagnostic remains available in the
  // server logs and the normal application observability path.
  return Response.json(
    {
      status: ok ? "ok" : "unavailable",
      database: ok ? "ok" : "unavailable",
      latencyMs: health.latencyMs,
    },
    {
      status: ok ? 200 : 503,
      headers: { "Cache-Control": "no-store, max-age=0" },
    },
  );
}
