import { describe, expect, it } from "vitest";

import { GET } from "../src/app/api/health/route";

describe("GET /api/health", () => {
  it("reports database availability without exposing connection details", async () => {
    const response = await GET();
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(payload.status).toBe("ok");
    expect(payload.database).toBe("ok");
    expect(payload.latencyMs).toEqual(expect.any(Number));
    expect(payload).not.toHaveProperty("target");
    expect(payload).not.toHaveProperty("error");
  });
});
