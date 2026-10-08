import { afterEach, describe, expect, it, vi } from "vitest";

import { getSupabaseConfig } from "@/lib/supabase/config";

afterEach(() => vi.unstubAllEnvs());

describe("Supabase public configuration", () => {
  it("stays disabled when either public setting is missing", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");
    expect(getSupabaseConfig()).toBeNull();
  });

  it("accepts an HTTPS project URL and public anon key", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://ofoq-project.supabase.co/");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "public-anon-key");
    expect(getSupabaseConfig()).toEqual({ url: "https://ofoq-project.supabase.co", anonKey: "public-anon-key" });
  });

  it("rejects plain HTTP outside localhost", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://ofoq-project.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "public-anon-key");
    expect(getSupabaseConfig()).toBeNull();
  });

  it("allows local Supabase over HTTP during development only", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "public-anon-key");
    expect(getSupabaseConfig()?.url).toBe("http://localhost:54321");
  });
});
