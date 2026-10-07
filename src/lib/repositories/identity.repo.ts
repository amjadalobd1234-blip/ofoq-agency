import { getDb } from "@/lib/db";
import type { DbDriver } from "@/lib/db/types";
import type { SessionRow, UserRow, VerificationTokenRow } from "@/lib/domain/types";
import { nowIso } from "@/lib/core/date";

import { type Dict, clean, deleteRow, findRowById, insertRow, updateRow } from "./base";

/* -------------------------------------------------------------------- users */

export async function findUserById(id: string, db?: DbDriver): Promise<UserRow | undefined> {
  return findRowById<UserRow>("users", id, db);
}

export async function findUserByEmail(email: string, db?: DbDriver): Promise<UserRow | undefined> {
  const driver = db ?? (await getDb());
  return driver.get<UserRow>("SELECT * FROM users WHERE email = ? COLLATE NOCASE", [email.toLowerCase()]);
}

export async function findUserByGoogleSub(sub: string, db?: DbDriver): Promise<UserRow | undefined> {
  const driver = db ?? (await getDb());
  return driver.get<UserRow>("SELECT * FROM users WHERE google_sub = ?", [sub]);
}

export async function createUser(
  data: Partial<UserRow> & { email: string; name: string; role: UserRow["role"] },
  db?: DbDriver,
): Promise<UserRow> {
  const timestamp = nowIso();
  const row: UserRow = {
    id: data.id ?? crypto.randomUUID(),
    email: data.email.toLowerCase(),
    password_hash: data.password_hash ?? null,
    name: data.name,
    role: data.role,
    status: data.status ?? "ACTIVE",
    locale: data.locale ?? "ar",
    phone: data.phone ?? null,
    country: data.country ?? null,
    avatar_url: data.avatar_url ?? null,
    google_sub: data.google_sub ?? null,
    email_verified_at: data.email_verified_at ?? null,
    last_login_at: data.last_login_at ?? null,
    is_demo: data.is_demo ?? 0,
    created_at: data.created_at ?? timestamp,
    updated_at: timestamp,
  };
  await insertRow("users", row as unknown as Dict, db);
  return row;
}

export async function updateUser(id: string, data: Partial<UserRow>, db?: DbDriver): Promise<void> {
  const driver = db ?? (await getDb());
  await updateRow("users", id, { ...clean(data as never), updated_at: nowIso() }, driver);
}

export async function listStaffUsers(db?: DbDriver): Promise<UserRow[]> {
  const driver = db ?? (await getDb());
  return driver.query<UserRow>(
    "SELECT * FROM users WHERE role IN ('OWNER', 'PARTNER') AND status = 'ACTIVE' ORDER BY role, created_at",
  );
}

export async function countUsersByRole(db?: DbDriver): Promise<Record<string, number>> {
  const driver = db ?? (await getDb());
  const rows = await driver.query<{ role: string; total: number }>(
    "SELECT role, COUNT(*) AS total FROM users GROUP BY role",
  );
  return Object.fromEntries(rows.map((row) => [row.role, Number(row.total)]));
}

/* ----------------------------------------------------------------- sessions */

export async function createSession(
  data: { id: string; user_id: string; token_hash: string; user_agent?: string | null; ip?: string | null; expires_at: string },
  db?: DbDriver,
): Promise<void> {
  await insertRow(
    "sessions",
    {
      id: data.id,
      user_id: data.user_id,
      token_hash: data.token_hash,
      user_agent: data.user_agent ?? null,
      ip: data.ip ?? null,
      created_at: nowIso(),
      last_seen_at: nowIso(),
      expires_at: data.expires_at,
      revoked_at: null,
    },
    db,
  );
}

export async function findSessionByTokenHash(
  tokenHash: string,
  db?: DbDriver,
): Promise<SessionRow | undefined> {
  const driver = db ?? (await getDb());
  return driver.get<SessionRow>(
    "SELECT * FROM sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?",
    [tokenHash, nowIso()],
  );
}

export async function touchSession(id: string, lastSeenAt: string, db?: DbDriver): Promise<void> {
  const driver = db ?? (await getDb());
  await driver.run("UPDATE sessions SET last_seen_at = ? WHERE id = ?", [lastSeenAt, id]);
}

export async function revokeSession(id: string, db?: DbDriver): Promise<void> {
  const driver = db ?? (await getDb());
  await driver.run("UPDATE sessions SET revoked_at = ? WHERE id = ?", [nowIso(), id]);
}

export async function revokeUserSessions(userId: string, exceptSessionId?: string, db?: DbDriver): Promise<number> {
  const driver = db ?? (await getDb());
  const result = exceptSessionId
    ? await driver.run(
        "UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id <> ? AND revoked_at IS NULL",
        [nowIso(), userId, exceptSessionId],
      )
    : await driver.run("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", [
        nowIso(),
        userId,
      ]);
  return result.changes;
}

export async function listUserSessions(userId: string, db?: DbDriver): Promise<SessionRow[]> {
  const driver = db ?? (await getDb());
  return driver.query<SessionRow>(
    "SELECT * FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY last_seen_at DESC",
    [userId, nowIso()],
  );
}

export async function purgeExpiredSessions(db?: DbDriver): Promise<number> {
  const driver = db ?? (await getDb());
  const result = await driver.run("DELETE FROM sessions WHERE expires_at < ?", [
    new Date(Date.now() - 7 * 86_400_000).toISOString(),
  ]);
  return result.changes;
}

/* ------------------------------------------------------ verification tokens */

export async function createVerificationToken(
  data: { id: string; user_id: string; type: VerificationTokenRow["type"]; token_hash: string; expires_at: string; meta?: string | null },
  db?: DbDriver,
): Promise<void> {
  await insertRow(
    "verification_tokens",
    {
      id: data.id,
      user_id: data.user_id,
      type: data.type,
      token_hash: data.token_hash,
      expires_at: data.expires_at,
      used_at: null,
      meta: data.meta ?? null,
      created_at: nowIso(),
    },
    db,
  );
}

export async function findVerificationToken(
  tokenHash: string,
  type: VerificationTokenRow["type"],
  db?: DbDriver,
): Promise<VerificationTokenRow | undefined> {
  const driver = db ?? (await getDb());
  return driver.get<VerificationTokenRow>(
    "SELECT * FROM verification_tokens WHERE token_hash = ? AND type = ? AND used_at IS NULL AND expires_at > ?",
    [tokenHash, type, nowIso()],
  );
}

export async function consumeVerificationToken(id: string, db?: DbDriver): Promise<void> {
  const driver = db ?? (await getDb());
  await driver.run("UPDATE verification_tokens SET used_at = ? WHERE id = ?", [nowIso(), id]);
}

/** Invalidates outstanding tokens of one type so only the newest link works. */
export async function invalidateVerificationTokens(
  userId: string,
  type: VerificationTokenRow["type"],
  db?: DbDriver,
): Promise<void> {
  const driver = db ?? (await getDb());
  await driver.run(
    "UPDATE verification_tokens SET used_at = ? WHERE user_id = ? AND type = ? AND used_at IS NULL",
    [nowIso(), userId, type],
  );
}

/* --------------------------------------------------------- login attempts --- */

export async function recordLoginAttempt(
  data: { email: string; ip?: string | null; success: boolean; reason?: string | null },
  db?: DbDriver,
): Promise<void> {
  await insertRow(
    "login_attempts",
    {
      id: crypto.randomUUID(),
      email: data.email.toLowerCase(),
      ip: data.ip ?? null,
      success: data.success ? 1 : 0,
      reason: data.reason ?? null,
      created_at: nowIso(),
    },
    db,
  );
}

export async function countRecentFailedLogins(
  email: string,
  windowMinutes = 15,
  db?: DbDriver,
): Promise<number> {
  const driver = db ?? (await getDb());
  const since = new Date(Date.now() - windowMinutes * 60_000).toISOString();
  const row = await driver.get<{ total: number }>(
    "SELECT COUNT(*) AS total FROM login_attempts WHERE email = ? AND success = 0 AND created_at > ?",
    [email.toLowerCase(), since],
  );
  return Number(row?.total ?? 0);
}

/* --------------------------------------------------------------- rate limits */

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Fixed-window rate limiter backed by the database so limits hold across
 * processes and serverless instances.
 */
export async function consumeRateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
  db?: DbDriver,
): Promise<RateLimitResult> {
  const driver = db ?? (await getDb());
  const now = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(now / windowSeconds) * windowSeconds;

  return driver.transaction(async (tx) => {
    const row = await tx.get<{ key: string; window_start: number; count: number }>(
      "SELECT * FROM rate_limits WHERE key = ?",
      [key],
    );

    if (!row || row.window_start !== windowStart) {
      if (row) {
        await tx.run(
          "UPDATE rate_limits SET window_start = ?, count = 1, blocked_until = NULL WHERE key = ?",
          [windowStart, key],
        );
      } else {
        await insertRow("rate_limits", { key, window_start: windowStart, count: 1 }, tx);
      }
      return { allowed: true, remaining: limit - 1, retryAfterSeconds: 0 };
    }

    const nextCount = Number(row.count) + 1;
    await tx.run("UPDATE rate_limits SET count = ? WHERE key = ?", [nextCount, key]);
    if (nextCount > limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: windowStart + windowSeconds - now,
      };
    }
    return { allowed: true, remaining: limit - nextCount, retryAfterSeconds: 0 };
  });
}

/* ------------------------------------------------------------------- misc --- */

export async function deleteUser(id: string, db?: DbDriver): Promise<number> {
  return deleteRow("users", id, db);
}

export async function findUserWithPassword(
  email: string,
  db?: DbDriver,
): Promise<UserRow | undefined> {
  const driver = db ?? (await getDb());
  return driver.get<UserRow>("SELECT * FROM users WHERE email = ? COLLATE NOCASE", [email.toLowerCase()]);
}
