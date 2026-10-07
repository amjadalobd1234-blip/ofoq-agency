import crypto from "node:crypto";

import { getEnv } from "@/lib/config/env";

/**
 * Encryption for third-party tokens at rest (AES-256-GCM).
 *
 * Only tokens we obtain from integrations (for example a Google refresh token)
 * are stored this way — never card data, which the platform does not accept at
 * all. The key comes from APP_ENCRYPTION_KEY (32 bytes, base64) and is never
 * written to the database or logs.
 *
 * When no key is configured, `encryptionAvailable()` is false and integrations
 * that need token storage stay disabled rather than storing secrets in clear
 * text.
 */
export function encryptionAvailable(): boolean {
  const env = getEnv();
  if (!env.auth.encryptionKey) return false;
  try {
    return decodeKey(env.auth.encryptionKey).length === 32;
  } catch {
    return false;
  }
}

function decodeKey(key: string): Buffer {
  const buffer = Buffer.from(key, "base64");
  if (buffer.length === 32) return buffer;
  // Allow hex keys as a convenience for operators who generate them that way.
  const hex = Buffer.from(key, "hex");
  if (hex.length === 32) return hex;
  return buffer;
}

export function encryptSecret(plaintext: string): string {
  if (!encryptionAvailable()) {
    throw new Error(
      "APP_ENCRYPTION_KEY is not configured (32 bytes, base64). Token storage is disabled.",
    );
  }
  const key = decodeKey(getEnv().auth.encryptionKey);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), encrypted.toString("base64")].join(".");
}

export function decryptSecret(payload: string): string {
  const key = decodeKey(getEnv().auth.encryptionKey);
  const [ivB64, tagB64, dataB64] = payload.split(".");
  if (!ivB64 || !tagB64 || !dataB64) throw new Error("Malformed encrypted payload");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}

/** Verifies an HMAC-SHA256 signature (used by webhook handlers). */
export function verifyHmacSignature(
  secret: string,
  payload: string,
  signature: string,
  encoding: "hex" | "base64" = "hex",
): boolean {
  if (!secret || !signature) return false;
  const expected = crypto.createHmac("sha256", secret).update(payload, "utf8").digest(encoding);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Generates a strong value for operators (used by the setup script). */
export function generateSecret(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64");
}
