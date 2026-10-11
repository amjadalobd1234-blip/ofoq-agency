import { jsonWithSession } from "@/lib/supabase/route-response";
import { requireSupabaseUser, rpcFailureResponse } from "@/lib/supabase/route-auth";

export const dynamic = "force-dynamic";

/**
 * Returns the signed-in user's own profile (id, name, email, role, status, locale).
 *
 * Reads public.users with the caller's JWT, so RLS (`ofoq_user_read_self`) limits
 * the result to the caller's own row, and only the columns granted to
 * `authenticated` are selectable. No service-role key is involved.
 *
 * 401 → no valid session. Client pages send the visitor to /login.
 *
 * The session is read from THIS request, and a token the SDK refreshes during
 * the call is written back on the response (requireSupabaseUser(request) +
 * jsonWithSession) — otherwise the page that asked «who am I?» would keep a
 * token the server has already replaced.
 */
export async function GET(request: Request) {
  const auth = await requireSupabaseUser(request);
  if (auth.response) return auth.response;

  const { data, error } = await auth.client
    .from("users")
    .select("id, name, email, role, status, locale")
    .eq("id", auth.user.id)
    .maybeSingle();

  if (error) {
    // Full error server-side only.
    // eslint-disable-next-line no-console
    console.error("[api/me] users lookup failed:", { message: error.message, code: error.code, userId: auth.user.id });
    return rpcFailureResponse(error);
  }

  if (!data) {
    // Auth user exists but has no platform profile (e.g. created before the trigger was installed).
    return jsonWithSession(
      auth,
      { error: "Your session is not active. Sign in again or contact the agency." },
      { status: 403 },
    );
  }

  return jsonWithSession(auth, { data });
}
