import { describe, expect, it } from "vitest";

import {
  changePassword,
  hashPassword,
  loginWithPassword,
  registerClient,
  requestPasswordReset,
  resetPasswordWithToken,
  resolveSession,
  toAuthenticatedUser,
  verifyEmailWithToken,
  verifyPassword,
} from "../src/lib/services/identity.service";
import { assertCustomerAccess, can, capabilitiesFor, requireCapability } from "../src/lib/auth/permissions";
import { consumeRateLimit } from "../src/lib/repositories/identity.repo";
import type { AuthenticatedUser } from "../src/lib/domain/types";

describe("password hashing", () => {
  it("hashes with a per-user salt and verifies correctly", async () => {
    const hash = await hashPassword("StrongPass123");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(hash).not.toContain("StrongPass123");
    expect(await verifyPassword("StrongPass123", hash)).toBe(true);
    expect(await verifyPassword("wrong", hash)).toBe(false);
    expect(await verifyPassword("StrongPass123", null)).toBe(false);
  });

  it("produces different hashes for the same password", async () => {
    const first = await hashPassword("SamePass123");
    const second = await hashPassword("SamePass123");
    expect(first).not.toBe(second);
  });
});

describe("registration and sign-in", () => {
  it("registers a client, verifies the email and signs in", async () => {
    const email = `client-${Date.now()}@example.test`;
    const { user, verificationToken } = await registerClient({
      email,
      password: "Password123",
      name: "Test Client",
      locale: "ar",
    });
    expect(user.role).toBe("CLIENT");
    expect(user.email_verified_at).toBeNull();

    const verified = await verifyEmailWithToken(verificationToken);
    expect(verified.email_verified_at).not.toBeNull();

    const { user: signedIn, session } = await loginWithPassword(email, "Password123", { ip: "127.0.0.1" });
    expect(signedIn.id).toBe(user.id);

    // The session token is random and only its hash is stored.
    const resolved = await resolveSession(session.token);
    expect(resolved?.user.id).toBe(user.id);
    expect(session.token.length).toBeGreaterThan(20);
  });

  it("rejects duplicate registrations", async () => {
    const email = `dup-${Date.now()}@example.test`;
    await registerClient({ email, password: "Password123", name: "First" });
    await expect(registerClient({ email, password: "Password123", name: "Second" })).rejects.toThrow();
  });

  it("rejects weak passwords", async () => {
    await expect(
      registerClient({ email: `weak-${Date.now()}@example.test`, password: "short", name: "Weak" }),
    ).rejects.toThrow(/password/i);
  });

  it("does not reveal whether an email exists when checking sign-in", async () => {
    await expect(
      loginWithPassword(`missing-${Date.now()}@example.test`, "Password123"),
    ).rejects.toThrow("Email or password is incorrect");
  });

  it("issues a single-use password reset token and revokes sessions afterwards", async () => {
    const email = `reset-${Date.now()}@example.test`;
    const { user } = await registerClient({ email, password: "Password123", name: "Reset" });
    const { session } = await loginWithPassword(email, "Password123");

    const token = await requestPasswordReset(email);
    expect(token).toBeTruthy();
    await resetPasswordWithToken(token!, "NewPassword456");

    // The old session must not survive a password change.
    expect(await resolveSession(session.token)).toBeNull();
    await expect(loginWithPassword(email, "Password123")).rejects.toThrow();
    const again = await loginWithPassword(email, "NewPassword456");
    expect(again.user.id).toBe(user.id);

    // The token cannot be reused.
    await expect(resetPasswordWithToken(token!, "AnotherPass789")).rejects.toThrow();
  });

  it("changes the password only with the current one", async () => {
    const email = `change-${Date.now()}@example.test`;
    const { user } = await registerClient({ email, password: "Password123", name: "Change" });
    await expect(changePassword(user.id, "wrong", "NewPassword456")).rejects.toThrow();
    await changePassword(user.id, "Password123", "NewPassword456");
    const { user: signedIn } = await loginWithPassword(email, "NewPassword456");
    expect(signedIn.id).toBe(user.id);
  });
});

describe("rate limiting", () => {
  it("blocks after the configured number of attempts in a window", async () => {
    const key = `test-limit-${Date.now()}`;
    for (let index = 0; index < 3; index += 1) {
      const result = await consumeRateLimit(key, 3, 60);
      expect(result.allowed).toBe(true);
    }
    const blocked = await consumeRateLimit(key, 3, 60);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });
});

describe("roles and capabilities", () => {
  const staff: AuthenticatedUser = {
    id: "u1",
    email: "partner@ofaq.test",
    name: "Partner",
    role: "PARTNER",
    locale: "ar",
    status: "ACTIVE",
    customerId: null,
  };
  const owner: AuthenticatedUser = { ...staff, id: "u2", role: "OWNER" };
  const client: AuthenticatedUser = {
    ...staff,
    id: "u3",
    role: "CLIENT",
    email: "client@ofaq.test",
    customerId: "customer-1",
  };

  it("gives the partner full operational capability", () => {
    const capabilities = capabilitiesFor("PARTNER");
    expect(capabilities).toContain("customers.manage");
    expect(capabilities).toContain("offers.manage");
    expect(capabilities).toContain("payments.manage");
    expect(capabilities).toContain("agents.manage");
    expect(capabilities).toContain("settings.manage");
    // Only the irreversible platform-wide operations stay with the owner.
    expect(capabilities).not.toContain("system.dangerous_delete");
    expect(capabilitiesFor("OWNER")).toContain("system.dangerous_delete");
  });

  it("keeps clients out of staff areas", () => {
    expect(can(client, "customers.manage")).toBe(false);
    expect(can(client, "payments.manage")).toBe(false);
    expect(can(client, "projects.view")).toBe(true);
    expect(can(staff, "projects.view")).toBe(true);
  });

  it("rejects the dangerous capability for a partner", () => {
    expect(() => requireCapability(staff, "system.dangerous_delete")).toThrow(/owner/i);
    expect(requireCapability(owner, "system.dangerous_delete").id).toBe("u2");
  });

  it("isolates each client to their own data", () => {
    expect(() => assertCustomerAccess(client, "customer-1")).not.toThrow();
    expect(() => assertCustomerAccess(client, "customer-2")).toThrow();
    // A client without a linked customer record never reaches data.
    expect(() => assertCustomerAccess({ ...client, customerId: null }, "customer-1")).toThrow();
    // Staff may work across clients.
    expect(() => assertCustomerAccess(staff, "customer-2")).not.toThrow();
  });

  it("maps a user row to the authenticated shape without linked staff data", async () => {
    const { user } = await registerClient({
      email: `shape-${Date.now()}@example.test`,
      password: "Password123",
      name: "Shape",
    });
    const authenticated = await toAuthenticatedUser(user);
    expect(authenticated.customerId).toBeNull();
    expect(authenticated.role).toBe("CLIENT");
  });
});
