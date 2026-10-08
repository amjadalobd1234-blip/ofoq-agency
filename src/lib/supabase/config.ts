export interface SupabasePublicConfig {
  url: string;
  anonKey: string;
}

/** Public Supabase settings only. A service-role key is deliberately not supported. */
export function getSupabaseConfig(): SupabasePublicConfig | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/\/$/, "");
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!url || !anonKey) return null;

  try {
    const parsed = new URL(url);
    const localHttp = process.env.NODE_ENV !== "production" &&
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
    if (parsed.protocol !== "https:" && !localHttp) return null;
    return { url, anonKey };
  } catch {
    return null;
  }
}

export function isSupabaseConfigured(): boolean {
  return getSupabaseConfig() !== null;
}
