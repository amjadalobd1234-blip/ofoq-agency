import { afterEach, describe, expect, it, vi } from "vitest";

import { getSupabaseAuthStorageKey, getSupabaseBrowserBaseUrl, getSupabaseConfig } from "@/lib/supabase/config";

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
    expect(getSupabaseConfig()).toEqual({
      url: "https://ofoq-project.supabase.co",
      anonKey: "public-anon-key",
      proxyUrl: null,
    });
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

describe("Supabase proxy configuration", () => {
  it("accepts a same-origin proxy path and strips trailing slashes", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://ofoq-project.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "public-anon-key");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PROXY_URL", "/api/supabase-proxy/");
    expect(getSupabaseConfig()?.proxyUrl).toBe("/api/supabase-proxy");
  });

  it("accepts an absolute HTTPS proxy URL", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://ofoq-project.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "public-anon-key");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PROXY_URL", "https://ofoq.example.com/api/supabase-proxy");
    expect(getSupabaseConfig()?.proxyUrl).toBe("https://ofoq.example.com/api/supabase-proxy");
  });

  it("rejects protocol-relative and script URLs", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://ofoq-project.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "public-anon-key");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PROXY_URL", "//evil.example.com");
    expect(getSupabaseConfig()?.proxyUrl).toBeNull();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PROXY_URL", "javascript:alert(1)");
    expect(getSupabaseConfig()?.proxyUrl).toBeNull();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PROXY_URL", "/api/../secret");
    expect(getSupabaseConfig()?.proxyUrl).toBeNull();
  });

  it("keeps the browser base URL direct when no proxy is configured", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://ofoq-project.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "public-anon-key");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PROXY_URL", "");
    const config = getSupabaseConfig();
    expect(config).not.toBeNull();
    expect(getSupabaseBrowserBaseUrl(config!)).toBe("https://ofoq-project.supabase.co");
  });

  it("uses the proxy URL for the browser when configured (window unavailable falls back safely)", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://ofoq-project.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "public-anon-key");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PROXY_URL", "/api/supabase-proxy");
    const config = getSupabaseConfig();
    expect(config?.proxyUrl).toBe("/api/supabase-proxy");
    // In the Node test environment there is no window: server-side must stay direct.
    expect(getSupabaseBrowserBaseUrl(config!)).toBe("https://ofoq-project.supabase.co");
  });
});

describe("Supabase session cookie name", () => {
  it("is derived from the project URL, matching the supabase-js server-side default", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://ofoq-project.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "public-anon-key");
    const config = getSupabaseConfig();
    // supabase-js derives `sb-<first hostname label>-auth-token` from the URL it
    // is given; the middleware and route handlers always use the project URL.
    expect(getSupabaseAuthStorageKey(config!)).toBe("sb-ofoq-project-auth-token");
  });

  it("stays pinned to the project URL even when the proxy is configured", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://ofoq-project.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "public-anon-key");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PROXY_URL", "/api/supabase-proxy");
    const config = getSupabaseConfig();
    // The browser talks to the proxy host, but the cookie name must still match
    // what the middleware reads — otherwise logins bounce back to /login.
    expect(getSupabaseAuthStorageKey(config!)).toBe("sb-ofoq-project-auth-token");
  });
});
