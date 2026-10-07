import crypto from "node:crypto";

/** Opaque, sortable-ish unique identifiers (UUID v4 text, portable across DBs). */
export function uuid(): string {
  return crypto.randomUUID();
}

/** URL-safe random token (used for session and verification secrets). */
export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function sha256(input: string | Uint8Array): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function hmacSha256(secret: string, payload: string | Uint8Array): Buffer {
  return crypto.createHmac("sha256", secret).update(payload).digest();
}

export function timingSafeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return crypto.timingSafeEqual(bufferA, bufferB);
}

/** Human-readable reference numbers: OFQ-P-2026-0007, OFQ-O-2026-0012, … */
export function formatReference(prefix: string, sequence: number, year = new Date().getUTCFullYear()): string {
  return `OFQ-${prefix}-${year}-${String(sequence).padStart(4, "0")}`;
}

/** Derives the next sequence number from existing references of the same kind. */
export function nextSequence(existing: string[], prefix: string, year = new Date().getUTCFullYear()): number {
  const pattern = new RegExp(`^OFQ-${prefix}-${year}-(\\d+)$`);
  let max = 0;
  for (const reference of existing) {
    const match = pattern.exec(reference);
    if (!match) continue;
    const value = Number(match[1]);
    if (Number.isFinite(value) && value > max) max = value;
  }
  return max + 1;
}

/** Invoice numbering: INV-2026-0001. */
export function formatInvoiceNumber(sequence: number, year = new Date().getUTCFullYear()): string {
  return `INV-${year}-${String(sequence).padStart(4, "0")}`;
}

/** Next invoice sequence for the current year, derived from existing numbers. */
export function nextInvoiceSequence(existing: string[], year = new Date().getUTCFullYear()): number {
  const pattern = new RegExp(`^INV-${year}-(\\d+)$`);
  let max = 0;
  for (const number of existing) {
    const match = pattern.exec(number);
    if (!match) continue;
    const value = Number(match[1]);
    if (Number.isFinite(value) && value > max) max = value;
  }
  return max + 1;
}

/** Deterministic slug for services and other human-facing keys. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\u0600-\u06FF\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}
