import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import { getSupabaseConfig } from "./config";

/**
 * Request-scoped Supabase client. Supabase Auth and data access both use HTTPS;
 * the SDK sends user JWTs to the Supabase REST/Auth APIs and relies on database RLS.
 */
export async function createSupabaseServerClient() {
  const config = getSupabaseConfig();
  if (!config) return null;

  const cookieStore = await cookies();
  return createServerClient(config.url, config.anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        } catch {
          // Server components cannot mutate cookies; middleware and route handlers can.
        }
      },
    },
  });
}
