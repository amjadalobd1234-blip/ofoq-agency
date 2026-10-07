import { cookies } from "next/headers";

import { getEnv } from "@/lib/config/env";
import { addHours, nowIso } from "@/lib/core/date";
import { UnauthenticatedError } from "@/lib/core/errors";
import { randomToken, sha256 } from "@/lib/core/ids";
import type { SessionRow } from "@/lib/domain/types";
import {
  createSession,
  findSessionByTokenHash,
  revokeSession,
  revokeUserSessions,
  touchSession,
} from "@/lib/repositories/identity.repo";

/**
 * HTTP session plumbing.
 *
 * This module owns the cookie and the session row only: the token in the cookie is
 * random, and the database stores just its SHA-256 digest, so a database leak
 * cannot be replayed as a login. Turning a session into a signed-in user (with the
 * customer link and capability checks) is the job of `identity.service` and
 * `auth/permissions`.
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

export function sessionCookieOptions(expiresAt: string) {
  return cookieOptions(expiresAt);
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

  // Rotation: a fresh login invalidates the token the browser used before.
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

/** Resolves the active session row, or null. Never throws for an absent session. */
export async function getCurrentSession(): Promise<SessionRow | null> {
  const token = await currentSessionToken();
  if (!token) return null;

  const session = await findSessionByTokenHash(sha256(token));
  if (!session) return null;
  if (session.revoked_at) return null;
  if (new Date(session.expires_at).getTime() <= Date.now()) return null;

  // Throttled "last seen" update — at most once per 5 minutes.
  const lastSeen = new Date(session.last_seen_at).getTime();
  if (Date.now() - lastSeen > 5 * 60_000) {
    await touchSession(session.id, nowIso());
  }

  return session;
}

export async function requireCurrentSession(): Promise<SessionRow> {
  const session = await getCurrentSession();
  if (!session) throw new UnauthenticatedError();
  return session;
}

export async function signOutCurrentSession(): Promise<void> {
  const token = await currentSessionToken();
  if (token) {
    const session = await findSessionByTokenHash(sha256(token));
    if (session) await revokeSession(session.id);
  }
  await clearSessionCookie();
}

/** Used after a password change or any other security event. */
export async function revokeAllSessions(userId: string, exceptSessionId?: string): Promise<number> {
  return revokeUserSessions(userId, exceptSessionId);
}
