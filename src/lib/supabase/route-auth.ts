import type { User } from "@supabase/supabase-js";

import { createSupabaseServerClient } from "./server";

type ServerClient = NonNullable<Awaited<ReturnType<typeof createSupabaseServerClient>>>;

export async function requireSupabaseUser(): Promise<
  | { client: ServerClient; user: User; response?: never }
  | { client?: never; user?: never; response: Response }
> {
  const client = await createSupabaseServerClient();
  if (!client) {
    return {
      response: Response.json(
        { error: "Supabase Auth is not configured. Add the public Supabase URL and anon key." },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      ),
    };
  }

  const { data, error } = await client.auth.getUser();
  if (error || !data.user) {
    return {
      response: Response.json({ error: "Authentication required." }, { status: 401, headers: { "Cache-Control": "no-store" } }),
    };
  }

  return { client, user: data.user };
}

export function rpcFailureResponse(error: { code?: string; message?: string }): Response {
  const code = error.code ?? "";
  if (["PGRST202", "PGRST204", "42P01", "42883"].includes(code)) {
    return Response.json(
      { error: "Supabase portal migration is not installed yet. Apply docs/setup/supabase-setup.sql in the Supabase SQL Editor." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (code === "42501") {
    return Response.json({ error: "You do not have permission for this data." }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  if (code === "28000") {
    return Response.json({ error: "Your session is not active. Sign in again or contact the agency." }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  if (code === "P0001") {
    return Response.json({ error: "Please wait briefly before sending another message." }, { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": "5" } });
  }
  // Do not send SQL, schema names, or provider details back to the browser.
  return Response.json({ error: "Unable to load platform data right now." }, { status: 502, headers: { "Cache-Control": "no-store" } });
}
