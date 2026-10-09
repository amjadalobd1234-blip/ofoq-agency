import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { GET, OPTIONS, POST } from "../src/app/api/supabase-proxy/[...path]/route";

const SUPABASE_URL = "https://ofoq-project.supabase.co";
const ANON_KEY = "test-anon-key";

type NextRequestInit = ConstructorParameters<typeof NextRequest>[1];

function request(path: string, init?: NextRequestInit): NextRequest {
  return new NextRequest(`http://localhost:3000/api/supabase-proxy${path}`, init);
}

function ctx(...path: string[]) {
  return { params: Promise.resolve({ path }) };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("/api/supabase-proxy", () => {
  it("forwards GET requests to the Supabase project with apikey and query string", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", SUPABASE_URL);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", ANON_KEY);

    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(
      request("/auth/v1/health?apikey=abc", { headers: { apikey: ANON_KEY, "x-client-info": "supabase-ssr" } }),
      ctx("auth", "v1", "health"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [target, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(target).toBe(`${SUPABASE_URL}/auth/v1/health?apikey=abc`);
    const headers = new Headers(init.headers);
    expect(headers.get("apikey")).toBe(ANON_KEY);
    expect(headers.get("x-client-info")).toBe("supabase-ssr");
    expect(headers.get("host")).toBeNull();
  });

  it("forwards POST bodies unchanged (signup/RPC)", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", SUPABASE_URL);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", ANON_KEY);

    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const payload = JSON.stringify({ email: "user@example.com", password: "secret-pass" });
    const response = await POST(
      request("/auth/v1/signup", {
        method: "POST",
        headers: { apikey: ANON_KEY, "content-type": "application/json", authorization: `Bearer ${ANON_KEY}` },
        body: payload,
      }),
      ctx("auth", "v1", "signup"),
    );
    expect(response.status).toBe(200);

    const [target, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(target).toBe(`${SUPABASE_URL}/auth/v1/signup`);
    expect(init.method).toBe("POST");
    expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe(payload);
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${ANON_KEY}`);
  });

  it("passes 3xx redirects through so verify links work", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", SUPABASE_URL);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", ANON_KEY);

    const fetchMock = vi.fn(async () =>
      new Response(null, { status: 302, headers: { location: "https://site.example.com/auth/callback?next=/" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(request("/auth/v1/verify?token=abc&type=signup"), ctx("auth", "v1", "verify"));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://site.example.com/auth/callback?next=/");

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.redirect).toBe("manual");
  });

  it("rejects path traversal segments", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", SUPABASE_URL);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", ANON_KEY);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(request("/auth/v1/health"), ctx("auth", "..", "secret"));
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 503 when the Supabase URL is not configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_URL", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(request("/auth/v1/health"), ctx("auth", "v1", "health"));
    expect(response.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks cross-site browser embedding via Sec-Fetch-Site", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", SUPABASE_URL);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", ANON_KEY);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(
      request("/auth/v1/health", { headers: { "sec-fetch-site": "cross-site" } }),
      ctx("auth", "v1", "health"),
    );
    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps upstream network failures to 502 without leaking internals", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", SUPABASE_URL);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", ANON_KEY);
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));

    const response = await GET(request("/auth/v1/health"), ctx("auth", "v1", "health"));
    expect(response.status).toBe(502);
    const payload = await response.json();
    expect(payload.error).toContain("unreachable");
  });

  it("answers OPTIONS with permissive same-origin CORS headers", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", SUPABASE_URL);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", ANON_KEY);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));

    const response = await OPTIONS(
      request("/auth/v1/health", { method: "OPTIONS", headers: { origin: "http://localhost:3000" } }),
      ctx("auth", "v1", "health"),
    );
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
    expect(response.headers.get("access-control-allow-headers")).toContain("apikey");
  });
});
