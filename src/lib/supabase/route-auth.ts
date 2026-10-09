import type { User } from "@supabase/supabase-js";
import { cookies } from "next/headers";

import { getSupabaseAuthStorageKey, getSupabaseConfig } from "./config";
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
    // Logged server-side only (Netlify Function Logs). Cookie VALUES are never
    // logged — only names/counts — so tokens don't leak into logs.
    // - cookieCount 0 → browser isn't sending cookies at all.
    // - auth cookies present but no user → cookie name/format mismatch or invalid token.
    const cookieStore = await cookies();
    const all = cookieStore.getAll();
    const config = getSupabaseConfig();
    const expectedName = config ? getSupabaseAuthStorageKey(config) : null;
    // eslint-disable-next-line no-console
    console.error("[route-auth]", {
      hasCookies: all.length,
      cookieNames: all.map((c) => c.name),
      expectedAuthCookie: expectedName,
      hasExpectedAuthCookie: expectedName ? all.some((c) => c.name === expectedName || c.name.startsWith(`${expectedName}.`)) : false,
      authCookieSizes: all.filter((c) => c.name.startsWith("sb-")).map((c) => ({ name: c.name, length: c.value.length, base64Prefixed: c.value.startsWith("base64-") })),
      authError: error?.message,
      authErrorCode: error?.code,
      authErrorStatus: error?.status,
    });
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
