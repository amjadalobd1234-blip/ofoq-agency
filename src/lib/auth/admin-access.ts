import type { UserRole } from "@/lib/domain/types";

/**
 * Pure role rules for the admin surface. Kept free of server-only imports so the
 * client guard (/admin) and the owner-only shortcut (/dashboard) can share them.
 *
 * These checks only decide what the UI shows and where it redirects. The real
 * boundary is the `ofoq_admin_dashboard` RPC, which calls `ofoq_is_staff()` in the
 * database and rejects everyone else with SQLSTATE 42501.
 */

/** Roles allowed to open /admin (staff). */
export function canOpenAdmin(role: string | null | undefined): boolean {
  return role === "OWNER" || role === "PARTNER";
}

/** The shortcut from /dashboard into /admin is shown to the owner only. */
export function canSeeOwnerAdminLink(role: string | null | undefined): boolean {
  return role === "OWNER";
}

const ROLE_LABELS: Record<UserRole, [string, string]> = {
  OWNER: ["المالك", "Owner"],
  PARTNER: ["شريك", "Partner"],
  CLIENT: ["عميل", "Client"],
};

/** Human-readable role label for the header. Unknown values fall back to the raw string. */
export function roleLabel(role: string, locale: "ar" | "en"): string {
  const pair = ROLE_LABELS[role as UserRole];
  return pair ? pair[locale === "ar" ? 0 : 1] : role;
}
