import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The production database configuration of Ofoq.
 *
 * The live site runs on Cloudflare/Netlify + Supabase: the portal reads
 * Supabase over HTTPS (Data API + RLS/RPC) and the deployment environment
 * deliberately has NO `DATABASE_URL` (see docs/DEPLOY-AR.md). The agency
 * APIs (`/api/projects*`) talk to the *local* driver, so this suite pins down
 * what happens in that deployment:
 *
 *   1. `DATABASE_DRIVER=postgres` without `DATABASE_URL` must fail loudly —
 *      never fall back to a local store and write to the wrong database.
 *   2. In production without a usable store, the API must answer 503 with an
 *      actionable message instead of an opaque 500 or a silent empty list.
 *   3. The client portal keeps working without any local database, because it
 *      reads the approved plan from the Supabase dashboard RPC.
 */
const profiles = vi.hoisted(() => ({ byId: new Map<string, { id: string; role: string; status: string }>() }));

vi.mock("@/lib/supabase/config", () => ({
  getSupabaseConfig: () => ({ url: "https://test.supabase.co", anonKey: "test" }),
}));

vi.mock("@/lib/supabase/route-auth", () => ({
  requireSupabaseUser: (request: Request) => {
    const id = request.headers.get("x-test-user");
    if (!id) return Promise.resolve({ response: Response.json({ error: "auth" }, { status: 401 }) });
    return Promise.resolve({
      client: {}, user: { id }, requestId: "test",
      finalize: (response: Response) => response,
    });
  },
  fetchOwnProfile: (_client: unknown, id: string) => {
    const profile = profiles.byId.get(id);
    return Promise.resolve(profile ? { profile } : { error: { code: "NO_PROFILE", message: "none" } });
  },
}));

const { resolveDatabaseTarget } = await import("../src/lib/db");
const { closeDb, setDbForTesting } = await import("../src/lib/db");
const { getEnv } = await import("../src/lib/config/env");
const { ConfigurationError } = await import("../src/lib/core/errors");
const { GET: listProjects } = await import("../src/app/api/projects/route");
const { GET: listAds } = await import("../src/app/api/ads/route");
const { testDriver } = await import("./setup");

const ENV_KEYS = ["NODE_ENV", "DATABASE_DRIVER", "DATABASE_URL", "SQLITE_PATH"] as const;
let saved: Record<string, string | undefined> = {};

/** Sets an environment variable (NODE_ENV is read-only in the Next.js types). */
function setEnv(key: string, value: string): void {
  Object.assign(process.env, { [key]: value });
}

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  // The global setup injects an in-memory database; this suite needs the real
  // configuration path, so the injected driver is removed (and restored after).
  setDbForTesting(null);
  profiles.byId.set("u-owner", { id: "u-owner", role: "OWNER", status: "ACTIVE" });
});

afterEach(async () => {
  await closeDb();
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else setEnv(key, saved[key]!);
  }
  setDbForTesting(testDriver());
});

describe("the production database configuration", () => {
  it("uses PostgreSQL when DATABASE_URL is configured", () => {
    setEnv("DATABASE_DRIVER", "postgres");
    setEnv("DATABASE_URL", "postgres://user:pass@db.example.com:5432/ofoq");
    const target = resolveDatabaseTarget(getEnv());
    expect(target.kind).toBe("postgres");
  });

  it("refuses to fall back to a local store when PostgreSQL is selected without a URL", () => {
    setEnv("DATABASE_DRIVER", "postgres");
    delete process.env.DATABASE_URL;
    expect(() => resolveDatabaseTarget(getEnv())).toThrow(ConfigurationError);
    expect(() => resolveDatabaseTarget(getEnv())).toThrow(/DATABASE_URL/);
  });

  it("keeps the local store available outside production", () => {
    setEnv("NODE_ENV", "development");
    setEnv("DATABASE_DRIVER", "sqlite");
    setEnv("SQLITE_PATH", "./data/ofoq.sqlite");
    const target = resolveDatabaseTarget(getEnv());
    expect(target.kind).toBe("sqlite");
  });

  it("answers 503 with an actionable message when the production store is unusable", async () => {
    // A serverless deployment: no DATABASE_URL and no writable volume.
    setEnv("NODE_ENV", "production");
    setEnv("DATABASE_DRIVER", "sqlite");
    delete process.env.DATABASE_URL;
    // A read-only location: the local store can never be opened, exactly like
    // a serverless bundle without a volume.
    setEnv("SQLITE_PATH", "/proc/ofoq.sqlite");

    const response = await listProjects(
      new Request("http://localhost/api/projects", { headers: { "x-test-user": "u-owner" } }),
    );

    // Not an opaque 500, and not a fake empty list.
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string; code: string };
    expect(body.code).toBe("CONFIGURATION_ERROR");
    expect(body.error).toMatch(/DATABASE_URL/);
    expect(body.error).toMatch(/DEPLOY-AR/);
    // No internal detail (the file path) leaks into the answer.
    expect(body.error).not.toContain("/proc");
  });

  it("answers 503 on /api/ads too when the production store is unusable", async () => {
    setEnv("NODE_ENV", "production");
    setEnv("DATABASE_DRIVER", "postgres");
    delete process.env.DATABASE_URL;

    const response = await listAds(
      new Request("http://localhost/api/ads", { headers: { "x-test-user": "u-owner" } }),
    );

    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string; code: string };
    expect(body.code).toBe("CONFIGURATION_ERROR");
    expect(body.error).toMatch(/DATABASE_URL/);
  });
});
