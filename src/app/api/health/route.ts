import { checkDbHealth } from "@/lib/db";
import { getSupabaseConfig } from "@/lib/supabase/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public uptime probe. In Supabase deployments it checks the HTTPS Auth REST API. */
export async function GET(): Promise<Response> {
  const supabase = getSupabaseConfig();
  if (supabase) {
    const started = Date.now();
    try {
      const response = await fetch(`${supabase.url}/auth/v1/settings`, {
        headers: { apikey: supabase.anonKey },
        cache: "no-store",
        signal: AbortSignal.timeout(5_000),
      });
      const ok = response.ok;
      return Response.json(
        { status: ok ? "ok" : "unavailable", supabase: ok ? "ok" : "unavailable", latencyMs: Date.now() - started },
        { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store, max-age=0" } },
      );
    } catch {
      return Response.json(
        { status: "unavailable", supabase: "unavailable", latencyMs: Date.now() - started },
        { status: 503, headers: { "Cache-Control": "no-store, max-age=0" } },
      );
    }
  }

  // SQLite remains a local-development fallback, but a production deployment
  // without Supabase must not advertise the customer portal as healthy.
  const health = await checkDbHealth();
  const production = process.env.NODE_ENV === "production";
  const status = health.ok ? (production ? "degraded" : "ok") : "unavailable";
  return Response.json(
    {
      status,
      database: health.ok ? "ok" : "unavailable",
      supabase: "not_configured",
      latencyMs: health.latencyMs,
    },
    { status: health.ok && !production ? 200 : 503, headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}
