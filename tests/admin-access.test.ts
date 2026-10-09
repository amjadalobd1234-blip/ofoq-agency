import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { canOpenAdmin, canSeeOwnerAdminLink, roleLabel } from "../src/lib/auth/admin-access";

const rootDir = path.resolve(__dirname, "..");

describe("admin role rules", () => {
  it("lets only OWNER and PARTNER open /admin", () => {
    expect(canOpenAdmin("OWNER")).toBe(true);
    expect(canOpenAdmin("PARTNER")).toBe(true);
    expect(canOpenAdmin("CLIENT")).toBe(false);
    expect(canOpenAdmin("")).toBe(false);
    expect(canOpenAdmin(null)).toBe(false);
    expect(canOpenAdmin(undefined)).toBe(false);
  });

  it("shows the /dashboard admin shortcut to the owner only", () => {
    expect(canSeeOwnerAdminLink("OWNER")).toBe(true);
    expect(canSeeOwnerAdminLink("PARTNER")).toBe(false);
    expect(canSeeOwnerAdminLink("CLIENT")).toBe(false);
    expect(canSeeOwnerAdminLink(undefined)).toBe(false);
  });

  it("labels roles in both languages and falls back to the raw value", () => {
    expect(roleLabel("OWNER", "ar")).toBe("المالك");
    expect(roleLabel("OWNER", "en")).toBe("Owner");
    expect(roleLabel("PARTNER", "en")).toBe("Partner");
    expect(roleLabel("UNKNOWN", "en")).toBe("UNKNOWN");
  });
});

describe("/api/me column contract", () => {
  it("only selects columns that the Supabase setup grants to authenticated", () => {
    const route = fs.readFileSync(path.join(rootDir, "src", "app", "api", "me", "route.ts"), "utf8");
    const selected = /\.select\("([^"]+)"\)/.exec(route)?.[1].split(",").map((column) => column.trim()) ?? [];
    expect(selected).toEqual(["id", "name", "email", "role", "status", "locale"]);

    const authSql = fs.readFileSync(path.join(rootDir, "db", "migrations", "supabase", "0001_auth_portal.sql"), "utf8");
    const grant = /GRANT SELECT \(([^)]+)\)\s+ON TABLE public\.users TO authenticated/.exec(authSql)?.[1] ?? "";
    const granted = grant.split(",").map((column) => column.trim());
    for (const column of selected) {
      expect(granted, `column ${column} must be granted to authenticated`).toContain(column);
    }
  });
});
