import crypto from "node:crypto";
import { promisify } from "node:util";

import { getEnv } from "@/lib/config/env";
import { addHours, nowIso } from "@/lib/core/date";
import { ConflictError, ForbiddenError, NotFoundError, UnauthenticatedError, ValidationError } from "@/lib/core/errors";
import { randomToken, sha256 } from "@/lib/core/ids";
import { logger } from "@/lib/core/logger";
import type { AuthenticatedUser, Locale, PublicUser, UserRow } from "@/lib/domain/types";
import {
  consumeRateLimit,
  countRecentFailedLogins,
  createSession,
  createUser,
  createVerificationToken,
  consumeVerificationToken,
  findSessionByTokenHash,
  findUserByEmail,
  findUserById,
  findUserByGoogleSub,
  findVerificationToken,
  invalidateVerificationTokens,
  listUserSessions,
  recordLoginAttempt,
  revokeSession,
  revokeUserSessions,
  touchSession,
  updateUser,
} from "@/lib/repositories/identity.repo";
import { findCustomerByUserId } from "@/lib/repositories/customers.repo";

import { logActivity } from "./activity.service";
import { sendEmail } from "./email.service";

/**
 * Authentication and account lifecycle.
 *
 * Security properties:
 *  - Passwords are hashed with scrypt (per-user salt, tuned cost) and compared
 *    in constant time.
 *  - Session tokens are random 32-byte values; only their SHA-256 digest is
 *    stored, so a database leak does not expose usable sessions.
 *  - Failed logins are counted and rate limited per email and per IP.
 *  - Email verification and password reset use single-use, hashed, expiring
 *    tokens; requesting a new link invalidates the previous one.
 *  - Two-factor authentication is intentionally out of scope for v1, but
 *    `users.status` + the token table design leave room for a TOTP secret and
 *    recovery codes without a schema rewrite (see docs/SECURITY.md).
 */

const scrypt = promisify(crypto.scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: crypto.ScryptOptions,
) => Promise<Buffer>;

const SCRYPT_PARAMS = { N: 16_384, r: 8, p: 1 } as const;
const KEY_LENGTH = 64;

/* ------------------------------------------------------------- passwords ---- */

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, { ...SCRYPT_PARAMS });
  return [
    "scrypt",
    SCRYPT_PARAMS.N,
    SCRYPT_PARAMS.r,
    SCRYPT_PARAMS.p,
    salt.toString("base64"),
    derived.toString("base64"),
  ].join("$");
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const salt = Buffer.from(saltB64, "base64");
  const expected = Buffer.from(hashB64, "base64");
  const derived = await scrypt(password.normalize("NFKC"), salt, expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return crypto.timingSafeEqual(derived, expected);
}

export function passwordProblems(password: string): string[] {
  const problems: string[] = [];
  if (password.length < 8) problems.push("password_too_short");
  if (password.length > 200) problems.push("password_too_long");
  if (!/[A-Za-z\u0600-\u06FF]/.test(password)) problems.push("password_needs_letter");
  if (!/[0-9]/.test(password)) problems.push("password_needs_number");
  return problems;
}

/* ------------------------------------------------------------------ users --- */

export function toPublicUser(user: UserRow): PublicUser {
  const { password_hash: _passwordHash, ...rest } = user;
  return rest;
}

export async function toAuthenticatedUser(user: UserRow): Promise<AuthenticatedUser> {
  const customer = user.role === "CLIENT" ? await findCustomerByUserId(user.id) : undefined;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    locale: user.locale,
    status: user.status,
    customerId: customer?.id ?? null,
  };
}

export interface RegisterInput {
  email: string;
  password: string;
  name: string;
  locale?: Locale;
  phone?: string | null;
  country?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Self-service registration. Always creates a CLIENT account: staff accounts are
 * created deliberately by the owner/partner from the dashboard.
 */
export async function registerClient(input: RegisterInput): Promise<{ user: UserRow; verificationToken: string }> {
  const email = input.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new ValidationError("Please enter a valid email address", { field: "email" });
  }
  const problems = passwordProblems(input.password);
  if (problems.length > 0) {
    throw new ValidationError("The password does not meet the minimum requirements", {
      field: "password",
      problems,
    });
  }

  const rate = await consumeRateLimit(`register:${input.ip ?? "unknown"}`, 10, 3_600);
  if (!rate.allowed) {
    throw new ValidationError("Too many sign-up attempts from this network. Please try again later.");
  }

  const existing = await findUserByEmail(email);
  if (existing) {
    throw new ConflictError("An account with this email already exists. Try signing in instead.", {
      field: "email",
    });
  }

  const user = await createUser({
    email,
    name: input.name.trim() || email.split("@")[0] || "Client",
    role: "CLIENT",
    locale: input.locale ?? getEnv().defaultLocale,
    phone: input.phone ?? null,
    country: input.country ?? null,
    password_hash: await hashPassword(input.password),
    status: "ACTIVE",
  });

  const token = await issueVerificationToken(user.id, "EMAIL_VERIFY");
  await logActivity({
    actor_type: "USER",
    actor_user_id: user.id,
    actor_label: user.email,
    action: "auth.register",
    entity_type: "user",
    entity_id: user.id,
    summary: `New client account: ${user.email}`,
    ip: input.ip ?? null,
    user_agent: input.userAgent ?? null,
  });

  return { user, verificationToken: token };
}

export async function createStaffUser(input: {
  email: string;
  name: string;
  password: string;
  role: "OWNER" | "PARTNER";
  locale?: Locale;
  actorUserId?: string | null;
}): Promise<UserRow> {
  const email = input.email.trim().toLowerCase();
  const existing = await findUserByEmail(email);
  if (existing) {
    throw new ConflictError("A user with this email already exists", { field: "email" });
  }
  const problems = passwordProblems(input.password);
  if (problems.length > 0) {
    throw new ValidationError("The password does not meet the minimum requirements", { problems });
  }
  const user = await createUser({
    email,
    name: input.name.trim(),
    role: input.role,
    locale: input.locale ?? "ar",
    password_hash: await hashPassword(input.password),
    email_verified_at: nowIso(),
    status: "ACTIVE",
  });
  await logActivity({
    actor_type: "USER",
    actor_user_id: input.actorUserId ?? null,
    action: "staff.create",
    entity_type: "user",
    entity_id: user.id,
    summary: `Staff account created: ${user.email} (${user.role})`,
  });
  return user;
}

/* ----------------------------------------------------------------- sessions - */

export interface SessionContext {
  ip?: string | null;
  userAgent?: string | null;
}

export interface CreatedSession {
  sessionId: string;
  token: string;
  expiresAt: string;
}

export async function startSession(userId: string, context: SessionContext = {}): Promise<CreatedSession> {
  const env = getEnv();
  const token = randomToken(32);
  const expiresAt = addHours(new Date(), env.auth.sessionTtlHours).toISOString();
  const sessionId = crypto.randomUUID();
  await createSession({
    id: sessionId,
    user_id: userId,
    token_hash: sha256(token),
    user_agent: context.userAgent ?? null,
    ip: context.ip ?? null,
    expires_at: expiresAt,
  });
  return { sessionId, token, expiresAt };
}

export interface SessionUser {
  user: UserRow;
  sessionId: string;
  lastSeenAt: string;
  expiresAt: string;
}

export async function resolveSession(token: string | null | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  const session = await findSessionByTokenHash(sha256(token));
  if (!session) return null;
  const user = await findUserById(session.user_id);
  if (!user || user.status === "SUSPENDED" || user.status === "DELETED") return null;

  // Throttled sliding refresh: at most one write every 5 minutes per session.
  const lastSeen = new Date(session.last_seen_at).getTime();
  if (Date.now() - lastSeen > 300_000) {
    await touchSession(session.id, nowIso());
  }
  return {
    user,
    sessionId: session.id,
    lastSeenAt: session.last_seen_at,
    expiresAt: session.expires_at,
  };
}

export async function endSession(sessionId: string): Promise<void> {
  await revokeSession(sessionId);
}

export async function endAllSessions(userId: string, exceptSessionId?: string): Promise<number> {
  return revokeUserSessions(userId, exceptSessionId);
}

export async function activeSessions(userId: string) {
  return listUserSessions(userId);
}

/* ------------------------------------------------------------------- login -- */

export interface LoginResult {
  user: UserRow;
  session: CreatedSession;
}

export async function loginWithPassword(
  email: string,
  password: string,
  context: SessionContext = {},
): Promise<LoginResult> {
  const normalisedEmail = email.trim().toLowerCase();
  const rate = await consumeRateLimit(`login:${context.ip ?? "unknown"}:${normalisedEmail}`, 10, 900);
  if (!rate.allowed) {
    await recordLoginAttempt({ email: normalisedEmail, ip: context.ip, success: false, reason: "rate_limited" });
    throw new UnauthenticatedError("Too many sign-in attempts. Please wait a few minutes and try again.");
  }

  const recentFailures = await countRecentFailedLogins(normalisedEmail, 15);
  const user = await findUserByEmail(normalisedEmail);
  const passwordOk = user ? await verifyPassword(password, user.password_hash) : false;

  if (!user || !passwordOk) {
    await recordLoginAttempt({ email: normalisedEmail, ip: context.ip, success: false, reason: "bad_credentials" });
    await maybeRaiseBruteForceAlert(normalisedEmail, recentFailures + 1);
    throw new UnauthenticatedError("Email or password is incorrect");
  }

  if (user.status === "SUSPENDED" || user.status === "DELETED") {
    await recordLoginAttempt({ email: normalisedEmail, ip: context.ip, success: false, reason: "suspended" });
    throw new ForbiddenError("This account is not active. Please contact the agency.");
  }

  await recordLoginAttempt({ email: normalisedEmail, ip: context.ip, success: true });
  const session = await startSession(user.id, context);
  await updateUser(user.id, { last_login_at: nowIso() });
  await logActivity({
    actor_type: "USER",
    actor_user_id: user.id,
    actor_label: user.email,
    action: "auth.login",
    entity_type: "user",
    entity_id: user.id,
    summary: `${user.email} signed in`,
    ip: context.ip ?? null,
    user_agent: context.userAgent ?? null,
  });

  return { user, session };
}

async function maybeRaiseBruteForceAlert(email: string, failures: number): Promise<void> {
  if (failures < 5 || failures % 5 !== 0) return;
  try {
    const { raiseAlert } = await import("./alerts.service");
    await raiseAlert({
      severity: "URGENT",
      category: "security",
      title_ar: "محاولات دخول فاشلة متكررة",
      title_en: "Repeated failed sign-in attempts",
      body_ar: `تم رصد ${failures} محاولات دخول فاشلة للحساب ${email} خلال ١٥ دقيقة.`,
      body_en: `${failures} failed sign-in attempts for ${email} within 15 minutes.`,
      dedupe_key: `bruteforce:${email}:${new Date().toISOString().slice(0, 13)}`,
      meta: { email, failures },
    });
  } catch (error) {
    logger.warn("Failed to raise brute-force alert", { error });
  }
}

/* ------------------------------------------------- Google sign-in (OAuth) --- */

/**
 * Links or creates an account from a verified Google profile.
 * Only called after the ID token / userinfo response has been validated.
 */
export async function upsertGoogleUser(profile: {
  sub: string;
  email: string;
  name?: string;
  picture?: string | null;
  emailVerified: boolean;
}): Promise<{ user: UserRow; created: boolean }> {
  const existingGoogleUser = await findUserByGoogleSub(profile.sub);
  if (existingGoogleUser) return { user: existingGoogleUser, created: false };

  const email = profile.email.trim().toLowerCase();
  const byEmail = await findUserByEmail(email);
  if (byEmail) {
    await updateUser(byEmail.id, { google_sub: profile.sub });
    if (profile.emailVerified && !byEmail.email_verified_at) {
      await updateUser(byEmail.id, { email_verified_at: nowIso() });
    }
    return { user: { ...byEmail, google_sub: profile.sub }, created: false };
  }

  const user = await createUser({
    email,
    name: profile.name?.trim() || email.split("@")[0] || "Client",
    role: "CLIENT",
    locale: getEnv().defaultLocale,
    google_sub: profile.sub,
    avatar_url: profile.picture ?? null,
    status: "ACTIVE",
    email_verified_at: profile.emailVerified ? nowIso() : null,
  });

  await logActivity({
    actor_type: "USER",
    actor_user_id: user.id,
    actor_label: user.email,
    action: "auth.register_google",
    entity_type: "user",
    entity_id: user.id,
    summary: `Client account created with Google: ${user.email}`,
  });

  return { user, created: true };
}

/* -------------------------------------------------- email verification flow - */

export async function issueVerificationToken(
  userId: string,
  type: "EMAIL_VERIFY" | "PASSWORD_RESET",
  ttlHours = type === "EMAIL_VERIFY" ? 48 : 2,
): Promise<string> {
  await invalidateVerificationTokens(userId, type);
  const token = randomToken(32);
  await createVerificationToken({
    id: crypto.randomUUID(),
    user_id: userId,
    type,
    token_hash: sha256(token),
    expires_at: addHours(new Date(), ttlHours).toISOString(),
  });
  return token;
}

export async function sendVerificationEmail(user: UserRow, token: string): Promise<void> {
  const env = getEnv();
  const link = `${env.appUrl}/verify-email?token=${encodeURIComponent(token)}`;
  await sendEmail({
    to: user.email,
    userId: user.id,
    template: "email_verify",
    subject: user.locale === "ar" ? "تأكيد بريدك الإلكتروني — أفق" : "Confirm your email — Ofoq",
    text:
      user.locale === "ar"
        ? `مرحبًا ${user.name},\n\nلتفعيل حسابك في أفق اضغط الرابط التالي:\n${link}\n\nالرابط صالح لمدة ٤٨ ساعة.`
        : `Hi ${user.name},\n\nConfirm your Ofoq account by opening this link:\n${link}\n\nThe link is valid for 48 hours.`,
  });
}

export async function verifyEmailWithToken(token: string): Promise<UserRow> {
  const record = await findVerificationToken(sha256(token), "EMAIL_VERIFY");
  if (!record) throw new ValidationError("This verification link is invalid or has expired.");
  const user = await findUserById(record.user_id);
  if (!user) throw new NotFoundError("Account not found");
  await consumeVerificationToken(record.id);
  await updateUser(user.id, { email_verified_at: nowIso() });
  await logActivity({
    actor_type: "USER",
    actor_user_id: user.id,
    action: "auth.email_verified",
    entity_type: "user",
    entity_id: user.id,
    summary: `Email verified: ${user.email}`,
  });
  return { ...user, email_verified_at: nowIso() };
}

export async function requestPasswordReset(email: string, ip?: string | null): Promise<string | null> {
  const rate = await consumeRateLimit(`reset:${ip ?? "unknown"}`, 5, 900);
  if (!rate.allowed) {
    throw new ValidationError("Too many reset requests. Please try again later.");
  }
  const user = await findUserByEmail(email.trim().toLowerCase());
  // Never reveal whether the address exists.
  if (!user || user.status === "DELETED") return null;
  const token = await issueVerificationToken(user.id, "PASSWORD_RESET", 2);
  const env = getEnv();
  const link = `${env.appUrl}/reset-password?token=${encodeURIComponent(token)}`;
  await sendEmail({
    to: user.email,
    userId: user.id,
    template: "password_reset",
    subject: user.locale === "ar" ? "إعادة تعيين كلمة المرور — أفق" : "Reset your password — Ofoq",
    text:
      user.locale === "ar"
        ? `مرحبًا ${user.name},\n\nلإعادة تعيين كلمة المرور استخدم الرابط التالي:\n${link}\n\nالرابط صالح لمدة ساعتين. إذا لم تطلب ذلك، تجاهل هذه الرسالة.`
        : `Hi ${user.name},\n\nReset your password here:\n${link}\n\nThe link is valid for 2 hours. If you did not request this, ignore this email.`,
  });
  await logActivity({
    actor_type: "USER",
    actor_user_id: user.id,
    action: "auth.password_reset_requested",
    entity_type: "user",
    entity_id: user.id,
    summary: `Password reset requested for ${user.email}`,
    ip: ip ?? null,
  });
  return token;
}

export async function resetPasswordWithToken(token: string, newPassword: string): Promise<UserRow> {
  const problems = passwordProblems(newPassword);
  if (problems.length > 0) {
    throw new ValidationError("The password does not meet the minimum requirements", { problems });
  }
  const record = await findVerificationToken(sha256(token), "PASSWORD_RESET");
  if (!record) throw new ValidationError("This reset link is invalid or has expired.");
  const user = await findUserById(record.user_id);
  if (!user) throw new NotFoundError("Account not found");

  await consumeVerificationToken(record.id);
  await updateUser(user.id, { password_hash: await hashPassword(newPassword) });
  // Any existing session must not survive a password change.
  await revokeUserSessions(user.id);
  await logActivity({
    actor_type: "USER",
    actor_user_id: user.id,
    action: "auth.password_reset",
    entity_type: "user",
    entity_id: user.id,
    summary: `Password reset completed for ${user.email}`,
  });
  return user;
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  keepSessionId?: string,
): Promise<void> {
  const user = await findUserById(userId);
  if (!user) throw new NotFoundError("Account not found");
  const ok = await verifyPassword(currentPassword, user.password_hash);
  if (!ok) throw new UnauthenticatedError("The current password is incorrect");
  const problems = passwordProblems(newPassword);
  if (problems.length > 0) {
    throw new ValidationError("The password does not meet the minimum requirements", { problems });
  }
  await updateUser(user.id, { password_hash: await hashPassword(newPassword) });
  await revokeUserSessions(user.id, keepSessionId);
  await logActivity({
    actor_type: "USER",
    actor_user_id: user.id,
    action: "auth.password_changed",
    entity_type: "user",
    entity_id: user.id,
    summary: `Password changed for ${user.email}`,
  });
}

export async function updateProfile(
  userId: string,
  data: { name?: string; phone?: string | null; country?: string | null; locale?: Locale },
): Promise<UserRow> {
  const user = await findUserById(userId);
  if (!user) throw new NotFoundError("Account not found");
  await updateUser(userId, data);
  const updated = await findUserById(userId);
  return updated!;
}
