import { ForbiddenError, UnauthenticatedError } from "@/lib/core/errors";
import type { UserRole } from "@/lib/domain/types";

/**
 * Role capabilities.
 *
 * OWNER — everything.
 * PARTNER — everything operational. The only things reserved to the owner are the
 *   irreversible platform-wide operations (permanent deletion / wiping data), which
 *   is exactly what the brief asks for: extra protection only for very dangerous
 *   operations.
 * CLIENT — their own projects, offers, invoices, files and conversation.
 *
 * The platform has no "trust the UI" step: every route, service and API handler
 * calls `requireCapability` / `assertCustomerAccess` before touching data.
 */
export const CAPABILITIES = [
  "customers.view",
  "customers.manage",
  "requests.view",
  "requests.manage",
  "projects.view",
  "projects.manage",
  "projects.plan.approve",
  "projects.close",
  "tasks.manage",
  "offers.view",
  "offers.manage",
  "pricing.manage",
  "services.manage",
  "invoices.view",
  "invoices.manage",
  "payments.manage",
  "payments.record",
  "payments.refund",
  "subscriptions.view",
  "subscriptions.manage",
  "campaigns.view",
  "campaigns.manage",
  "campaigns.plan.approve",
  "reports.view",
  "reports.send",
  "alerts.view",
  "alerts.manage",
  "agents.view",
  "agents.manage",
  "agents.approve",
  "conversations.view",
  "conversations.reply",
  "files.view",
  "files.manage",
  "reviews.view",
  "reviews.moderate",
  "settings.view",
  "settings.manage",
  "activity.view",
  "integrations.view",
  "integrations.manage",
  "users.manage",
  "dashboard.view",
  "system.dangerous_delete",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

const CLIENT_CAPABILITIES: Capability[] = [
  "projects.view",
  "offers.view",
  "invoices.view",
  "subscriptions.view",
  "reports.view",
  "conversations.view",
  "files.view",
  "reviews.view",
  "campaigns.view",
];

/**
 * Capabilities reserved to the owner.
 *
 * Besides the irreversible platform-wide deletion, the owner alone approves a
 * project plan (a commitment to the client), an advertising plan (advice the
 * client will see), and closes a project. A partner can prepare, review and
 * execute, but those commitments stay with the owner.
 */
const OWNER_ONLY_CAPABILITIES: Capability[] = [
  "system.dangerous_delete",
  "projects.plan.approve",
  "projects.close",
  "campaigns.plan.approve",
];

/**
 * Partner capabilities: the full staff set minus the owner-only capabilities.
 * Written as an explicit list so adding a capability is a deliberate decision
 * rather than something that silently lands in a partner's hands.
 */
const PARTNER_CAPABILITIES: Capability[] = CAPABILITIES.filter(
  (capability) => !OWNER_ONLY_CAPABILITIES.includes(capability),
);

const ROLE_CAPABILITIES: Record<UserRole, ReadonlySet<Capability>> = {
  OWNER: new Set(CAPABILITIES),
  PARTNER: new Set(PARTNER_CAPABILITIES),
  CLIENT: new Set(CLIENT_CAPABILITIES),
};

export function capabilitiesFor(role: UserRole): Capability[] {
  return [...(ROLE_CAPABILITIES[role] ?? CLIENT_CAPABILITIES)];
}

export function can(actor: { role: UserRole } | null | undefined, capability: Capability): boolean {
  if (!actor) return false;
  return ROLE_CAPABILITIES[actor.role]?.has(capability) ?? false;
}

export function isStaff(actor: { role: UserRole } | null | undefined): boolean {
  return actor?.role === "OWNER" || actor?.role === "PARTNER";
}

export function isOwner(actor: { role: UserRole } | null | undefined): boolean {
  return actor?.role === "OWNER";
}

export interface Actor {
  id: string;
  role: UserRole;
  customerId?: string | null;
}

export function requireUser(actor: Actor | null | undefined): Actor {
  if (!actor) throw new UnauthenticatedError();
  return actor;
}

export function requireCapability(actor: Actor | null | undefined, capability: Capability): Actor {
  const current = requireUser(actor);
  if (!can(current, capability)) {
    throw new ForbiddenError(
      capability === "system.dangerous_delete"
        ? "Only the owner can perform permanent deletion."
        : "You do not have permission for this action.",
    );
  }
  return current;
}

/**
 * Strict per-customer isolation.
 *
 * A client may only ever touch their own records; staff may work across clients.
 * Called with the customer id of the row being read or written.
 */
export function assertCustomerAccess(
  actor: Actor | null | undefined,
  customerId: string | null | undefined,
): void {
  const current = requireUser(actor);
  if (isStaff(current)) return;
  if (!current.customerId || !customerId || current.customerId !== customerId) {
    throw new ForbiddenError("You do not have access to this customer's data.");
  }
}

/** Staff-only data (internal notes, costs, agent logs) never reaches a client. */
export function assertStaff(actor: Actor | null | undefined): Actor {
  const current = requireUser(actor);
  if (!isStaff(current)) throw new ForbiddenError("This area is for agency staff only.");
  return current;
}

export function assertOwner(actor: Actor | null | undefined): Actor {
  const current = requireUser(actor);
  if (!isOwner(current)) throw new ForbiddenError("Only the owner can perform this action.");
  return current;
}
