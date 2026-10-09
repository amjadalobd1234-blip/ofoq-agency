"use client";

import { canSeeOwnerAdminLink } from "@/lib/auth/admin-access";
import { useCurrentUser } from "@/lib/auth/use-current-user";
import type { Locale } from "@/lib/domain/types";

/** Small shortcut to /admin, rendered only for the OWNER role. Renders nothing otherwise. */
export function OwnerAdminLink({ locale }: { locale: Locale }) {
  const session = useCurrentUser();
  if (session.phase !== "ready" || !canSeeOwnerAdminLink(session.user.role)) return null;
  return (
    <a className="owner-admin-link" href="/admin">
      {locale === "ar" ? "لوحة الإدارة" : "Admin panel"}
      <span aria-hidden="true">↗</span>
    </a>
  );
}
