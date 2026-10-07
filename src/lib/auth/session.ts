import { cookies } from "next/headers";

import { getEnv } from "@/lib/config/env";
import { addHours, nowIso } from "@/lib/core/date";
import { randomToken, sha256 } from "@/lib/core/ids";
import { UnauthenticatedError } from "@/lib/core/errors";
import type { AuthenticatedUser, UserRow } from "@/lib/domain/types";
import {
  createSession,
  findSessionByTokenHash,
  findUserById,
  revokeSession,
  revokeUserSessions,
  touchSession,
} from "@/lib/repositories/identity.repo";

/**
 * Session handling.
 *
 * The cookie carries a random token; the database stores only its SHA-256 digest,
 * so a database leak cannot be replayed as a login. Sessions expire, are revoked
 * on password change, and every request validates both the session and the user.
 */

export const SESSION_COOKIE = "ofoq_session";

export interface IssuedSession {
  token: string;
  sessionId: string;
  expiresAt: string;
}

function cookieOptions(expiresAt: string) {
  const env = getEnv();
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: env.auth.cookieSecure,
    path: "/",
    expires: new Date(expiresAt),
  };
}

export async function issueSession(input: {
  userId: string;
  userAgent?: string | null;
  ip?: string | null;
  existingToken?: string | null;
}): Promise<IssuedSession> {
  const env = getEnv();
  const token = randomToken(32);
  const expiresAt = addHours(new Date(), env.auth.sessionTtlHours).toISOString();
  const sessionId = crypto.randomUUID();

  // Rotate: a fresh login invalidates the token the browser used before.
  if (input.existingToken) {
    const previous = await findSessionByTokenHash(sha256(input.existingToken));
    if (previous) await revokeSession(previous.id);
  }

  await createSession({
    id: sessionId,
    user_id: input.userId,
    token_hash: sha256(token),
    user_agent: input.userAgent ?? null,
    ip: input.ip ?? null,
    expires_at: expiresAt,
  });

  const store = await cookies();
  store.set(SESSION_COOKIE, token, cookieOptions(expiresAt));

  return { token, sessionId, expiresAt };
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, "", { ...cookieOptions(new Date(0).toISOString()), maxAge: 0 });
}

export async function currentSessionToken(): Promise<string | null> {
  const store = await cookies();
  return store.get(SESSION_COOKIE)?.value ?? null;
}

/** Resolves the signed-in user, or null. Never throws for an absent session. */
export async function getCurrentUser(): Promise<AuthenticatedUser | null> {
  const token = await currentSessionToken();
  if (!token) return null;

  const session = await findSessionByTokenHash(sha256(token));
  if (!session) return null;
  if (session.revoked_at) return null;
  if (new Date(session.expires_at).getTime() <= Date.now()) return null;

  const user = await findUserById(session.user_id);
  if (!user || user.status !== "ACTIVE") return null;

  // Throttled "last seen" update — at most once per 5 minutes.
  const lastSeen = new Date(session.last_seen_at).getTime();
  if (Date.now() - lastSeen > 5 * 60_000) {
    await touchSession(session.id, nowIso());
  }

  return user as AuthenticatedUser;
}

export async function requireCurrentUser(): Promise<AuthenticatedUser> {
  const user = await getCurrentUser();
  if (!user) throw new UnauthenticatedError();
  return user;
}

/** Staff helper used by the dashboard layout. */
export async function requireStaffUser(): Promise<AuthenticatedUser> {
  const user = await requireCurrentUser();
  if (user.role !== "OWNER" && user.role !== "PARTNER") {
    throw new UnauthenticatedError("This area is for agency staff.");
  }
  return user;
}

export async function requireClientUser(): Promise<AuthenticatedUser> {
  const user = await requireCurrentUser();
  if (user.role !== "CLIENT") {
    throw new UnauthenticatedError("This area is for client accounts.");
  }
  return user;
}

export async function signOutCurrentSession(): Promise<void> {
  const token = await currentSessionToken();
  if (token) {
    const session = await findSessionByTokenHash(sha256(token));
    if (session) await revokeSession(session.id);
  }
  await clearSessionCookie();
}

/** Used after a password change or a security event. */
export async function revokeAllSessions(userId: string, exceptSessionId?: string): Promise<number> {
  return revokeUserSessions(userId, exceptSessionId);
}

export function sessionCookieForTests(token: string, expiresAt: string) {
  return { name: SESSION_COOKIE, value: token, options: cookieOptions(expiresAt) };
}

export type { UserRow };
