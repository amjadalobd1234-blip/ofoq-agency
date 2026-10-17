import type {
  AdminAlertActivity,
  AdminAlertDetail,
  AdminAlertDetailsResponse,
  AdminAlertFilter,
  AdminAlertListItem,
  AdminAlertListResponse,
  AdminAlertMessage,
} from "./alert-types";

/**
 * Defensive normalisation for the staff-only `/admin` JSON payloads.
 *
 * Why this module exists
 * ----------------------
 * Every admin screen used to cast the API response straight to a TypeScript
 * interface (`payload.data as AdminData`) and then read fields deep inside the
 * render tree. `as` is a compile-time assertion only — it does nothing at
 * runtime. The moment the deployed `ofoq_admin_*` RPC returns a shape the
 * component did not expect (a database that has not applied the newest
 * migration yet, a partially-aggregated `jsonb`, an unexpected `null`), the
 * render threw:
 *
 *     TypeError: Cannot read properties of undefined (reading 'criticalAlerts')
 *
 * With no `error.tsx` boundary under `/admin`, React unmounted the tree and
 * Next.js replaced the page with its generic production message —
 * "Application error: a client-side exception has occurred" — which says
 * nothing about the cause.
 *
 * The normalisers below guarantee a fully-populated shape, so a stale or
 * partial payload degrades into an empty section instead of a blank crash page.
 * Authorisation is unaffected: it is enforced by the RPCs, not by this code.
 *
 * They are pure and dependency-free so client components can import them.
 */

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as UnknownRecord) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecords(value: unknown): UnknownRecord[] {
  return asArray(value).map(asRecord);
}

function str(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
}

function nullableStr(value: unknown): string | null {
  const text = str(value);
  return text ? text : null;
}

function num(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Postgres bigint columns arrive as either a JSON number or a numeric string. */
function minor(value: unknown): number | string {
  return typeof value === "string" ? value : num(value, 0);
}

/** Preserve SQL NULL for an offer that intentionally has no published price. */
function nullableMinor(value: unknown): number | string | null {
  return value === null || value === undefined ? null : minor(value);
}

/** Keeps a "missing" counter absent, so callers can still apply their fallback. */
function optionalNum(value: unknown): number | undefined {
  return value === undefined || value === null ? undefined : num(value);
}

function requiredStr(value: unknown, fallback: string): string {
  const text = str(value);
  return text ? text : fallback;
}

// ─── Alerts ──────────────────────────────────────────────────────────────────

export function normalizeAdminAlertItem(raw: unknown): AdminAlertListItem {
  const r = asRecord(raw);
  const createdAt = str(r.createdAt);
  return {
    id: str(r.id),
    // `severity` and `status` are interpolated into class names
    // (`severity-${severity}`), so they must never be null.
    severity: requiredStr(r.severity, "INFO"),
    category: str(r.category),
    titleAr: str(r.titleAr),
    titleEn: str(r.titleEn),
    bodyAr: nullableStr(r.bodyAr),
    bodyEn: nullableStr(r.bodyEn),
    status: requiredStr(r.status, "NEW") as AdminAlertListItem["status"],
    createdAt,
    updatedAt: str(r.updatedAt, createdAt),
    customerName: nullableStr(r.customerName),
    customerEmail: nullableStr(r.customerEmail),
    conversationId: nullableStr(r.conversationId),
  };
}

function normalizeAlertDetail(raw: unknown): AdminAlertDetail {
  return {
    ...normalizeAdminAlertItem(raw),
    entityType: nullableStr(asRecord(raw).entityType),
    entityId: nullableStr(asRecord(raw).entityId),
    targetRole: requiredStr(asRecord(raw).targetRole, "OWNER"),
    acknowledgedAt: nullableStr(asRecord(raw).acknowledgedAt),
    acknowledgedBy: nullableStr(asRecord(raw).acknowledgedBy),
    resolvedAt: nullableStr(asRecord(raw).resolvedAt),
    resolutionNote: nullableStr(asRecord(raw).resolutionNote),
  };
}

export function normalizeAdminAlertList(raw: unknown): AdminAlertListResponse {
  const r = asRecord(raw);
  return {
    items: asArray(r.items).map(normalizeAdminAlertItem),
    total: num(r.total),
    filter: requiredStr(r.filter, "ALL") as AdminAlertFilter,
    limit: num(r.limit, 50),
    offset: num(r.offset),
  };
}

export function normalizeAdminAlertDetails(raw: unknown): AdminAlertDetailsResponse {
  const r = asRecord(raw);
  const client = r.client;
  const conversation = r.conversation;

  return {
    alert: normalizeAlertDetail(r.alert),
    client: client && typeof client === "object" && !Array.isArray(client)
      ? {
          id: nullableStr(asRecord(client).id),
          name: nullableStr(asRecord(client).name),
          companyName: nullableStr(asRecord(client).companyName),
          email: nullableStr(asRecord(client).email),
          phone: nullableStr(asRecord(client).phone),
        }
      : null,
    conversation: conversation && typeof conversation === "object" && !Array.isArray(conversation)
      ? {
          id: str(asRecord(conversation).id),
          subject: nullableStr(asRecord(conversation).subject),
          status: requiredStr(asRecord(conversation).status, "OPEN"),
          lastMessageAt: nullableStr(asRecord(conversation).lastMessageAt),
        }
      : null,
    messages: asRecords(r.messages).map((m): AdminAlertMessage => ({
      id: str(m.id),
      sender: requiredStr(m.sender, "SYSTEM"),
      senderLabel: nullableStr(m.senderLabel),
      body: str(m.body),
      language: nullableStr(m.language),
      createdAt: str(m.createdAt),
    })),
    activities: asRecords(r.activities).map((a): AdminAlertActivity => ({
      id: str(a.id),
      action: requiredStr(a.action, "alert.updated"),
      actorType: requiredStr(a.actorType, "SYSTEM"),
      actorLabel: nullableStr(a.actorLabel),
      summary: nullableStr(a.summary),
      createdAt: str(a.createdAt),
    })),
  };
}

// ─── Dashboard ───────────────────────────────────────────────────────────────

export interface AdminDashboardTotals {
  customers: number;
  newCustomers7d: number;
  activeProjects: number;
  overdueProjects: number;
  newRequests: number;
  activeCampaigns: number;
  reports30d: number;
  pendingAgentActions: number;
  urgentAlerts: number;
  /** Alerts that must be handled now (severity = URGENT). Absent on older RPCs. */
  criticalAlerts?: number;
  /** Open HUMAN_REQUEST / NEW_LEAD alerts raised by the assistant. */
  newLeads?: number;
}

export interface AdminClientRow {
  id: string; name: string; companyName: string | null; email: string | null;
  country: string | null; status: string; createdAt: string;
}
export interface AdminOfferRow {
  id: string; code: string; status: string; currency: string; totalMinor: number | string | null;
  createdByAgent: string | null; createdAt: string; customerName: string; customerEmail: string | null;
}
export interface AdminProjectRow {
  id: string; code: string; title: string; status: string; progress: number;
  dueDate: string | null; customerName: string; amountTotalMinor: number | string;
  internalCostMinor: number | string; createdAt: string;
}
export interface AdminCampaignRow {
  id: string; name: string; platform: string; status: string; currency: string;
  totalBudgetMinor: number | string; monthlyBudgetMinor: number | string; spentMinor: number | string;
  syncStatus: string; customerName: string; updatedAt: string;
}
export interface AdminReportRow {
  id: string; title: string; type: string; status: string; customerName: string; createdAt: string;
}
export interface AdminAlertRow {
  id: string; severity: string; category: string; titleAr: string; titleEn: string;
  bodyAr: string | null; bodyEn: string | null; status: string; createdAt: string;
  customerName: string | null; customerEmail: string | null; conversationId: string | null;
}
export interface AdminAgentActionRow {
  id: string; agentKey: string; action: string; summary: string; reason: string | null;
  riskLevel: string; requiresApproval: number; createdAt: string;
}
export interface AdminMoneyBucket { currency: string; totalMinor: number | string; }

/**
 * Shape returned by the `ofoq_admin_dashboard` RPC through `/api/admin/dashboard`,
 * after `normalizeAdminDashboard` has filled in every field.
 *
 * The RPC returns the 8 most recent rows of each list, whatever their status.
 * Status filtering (new offers, active projects, pending approvals) happens in
 * the dashboard component, and the header counts come from `totals`, which the
 * database computes over every row.
 */
export interface AdminDashboardData {
  generatedAt: string;
  totals: AdminDashboardTotals;
  clients: AdminClientRow[];
  requests: AdminOfferRow[];
  projects: AdminProjectRow[];
  campaigns: AdminCampaignRow[];
  reports: AdminReportRow[];
  alerts: AdminAlertRow[];
  /** Open client escalations (HUMAN_REQUEST / NEW_LEAD). Absent on older RPCs. */
  leadRequests: AdminAlertRow[];
  agentActions: AdminAgentActionRow[];
  financials: { collected30d: AdminMoneyBucket[]; internalCost30d: AdminMoneyBucket[] };
  integrations: { googleAds: { status: string }; whatsapp: { status: string }; payments: { status: string } };
}

function normalizeAlertRows(raw: unknown): AdminAlertRow[] {
  return asRecords(raw).map((a) => ({
    id: str(a.id),
    severity: requiredStr(a.severity, "INFO"),
    category: str(a.category),
    titleAr: str(a.titleAr),
    titleEn: str(a.titleEn),
    bodyAr: nullableStr(a.bodyAr),
    bodyEn: nullableStr(a.bodyEn),
    status: requiredStr(a.status, "NEW"),
    createdAt: str(a.createdAt),
    customerName: nullableStr(a.customerName),
    customerEmail: nullableStr(a.customerEmail),
    conversationId: nullableStr(a.conversationId),
  }));
}

function normalizeMoneyBuckets(raw: unknown): AdminMoneyBucket[] {
  return asRecords(raw).map((b) => ({ currency: requiredStr(b.currency, "USD"), totalMinor: minor(b.totalMinor) }));
}

/** `integrations.googleAds` is `{ status: "…" }`; tolerate a bare string too. */
function integrationStatus(raw: unknown, fallback: string): string {
  const record = asRecord(raw);
  return requiredStr(typeof record.status === "string" ? record.status : raw, fallback);
}

/**
 * Turns whatever `/api/admin/dashboard` returned into a complete, renderable
 * `AdminDashboardData`. Never throws.
 */
export function normalizeAdminDashboard(raw: unknown): AdminDashboardData {
  const r = asRecord(raw);
  const t = asRecord(r.totals);
  const financials = asRecord(r.financials);
  const integrations = asRecord(r.integrations);

  return {
    generatedAt: str(r.generatedAt),
    totals: {
      customers: num(t.customers),
      newCustomers7d: num(t.newCustomers7d),
      activeProjects: num(t.activeProjects),
      overdueProjects: num(t.overdueProjects),
      newRequests: num(t.newRequests),
      activeCampaigns: num(t.activeCampaigns),
      reports30d: num(t.reports30d),
      pendingAgentActions: num(t.pendingAgentActions),
      urgentAlerts: num(t.urgentAlerts),
      criticalAlerts: optionalNum(t.criticalAlerts),
      newLeads: optionalNum(t.newLeads),
    },
    clients: asRecords(r.clients).map((c): AdminClientRow => ({
      id: str(c.id), name: str(c.name), companyName: nullableStr(c.companyName),
      email: nullableStr(c.email), country: nullableStr(c.country),
      status: requiredStr(c.status, "ACTIVE"), createdAt: str(c.createdAt),
    })),
    requests: asRecords(r.requests).map((o): AdminOfferRow => ({
      id: str(o.id), code: str(o.code), status: requiredStr(o.status, "DRAFT"),
      currency: requiredStr(o.currency, "USD"), totalMinor: nullableMinor(o.totalMinor),
      createdByAgent: nullableStr(o.createdByAgent), createdAt: str(o.createdAt),
      customerName: str(o.customerName), customerEmail: nullableStr(o.customerEmail),
    })),
    projects: asRecords(r.projects).map((p): AdminProjectRow => ({
      id: str(p.id), code: str(p.code), title: str(p.title), status: requiredStr(p.status, "PLANNING"),
      progress: num(p.progress), dueDate: nullableStr(p.dueDate), customerName: str(p.customerName),
      amountTotalMinor: minor(p.amountTotalMinor), internalCostMinor: minor(p.internalCostMinor),
      createdAt: str(p.createdAt),
    })),
    campaigns: asRecords(r.campaigns).map((c): AdminCampaignRow => ({
      id: str(c.id), name: str(c.name), platform: requiredStr(c.platform, "GOOGLE_ADS"),
      status: requiredStr(c.status, "ACTIVE"), currency: requiredStr(c.currency, "USD"),
      totalBudgetMinor: minor(c.totalBudgetMinor), monthlyBudgetMinor: minor(c.monthlyBudgetMinor),
      spentMinor: minor(c.spentMinor), syncStatus: requiredStr(c.syncStatus, "NOT_CONNECTED"),
      customerName: str(c.customerName), updatedAt: str(c.updatedAt),
    })),
    reports: asRecords(r.reports).map((rep): AdminReportRow => ({
      id: str(rep.id), title: str(rep.title), type: requiredStr(rep.type, "PERFORMANCE"),
      status: requiredStr(rep.status, "DRAFT"), customerName: str(rep.customerName), createdAt: str(rep.createdAt),
    })),
    alerts: normalizeAlertRows(r.alerts),
    leadRequests: normalizeAlertRows(r.leadRequests),
    agentActions: asRecords(r.agentActions).map((a): AdminAgentActionRow => ({
      id: str(a.id), agentKey: str(a.agentKey), action: str(a.action), summary: str(a.summary),
      reason: nullableStr(a.reason), riskLevel: requiredStr(a.riskLevel, "LOW"),
      requiresApproval: num(a.requiresApproval), createdAt: str(a.createdAt),
    })),
    financials: {
      collected30d: normalizeMoneyBuckets(financials.collected30d),
      internalCost30d: normalizeMoneyBuckets(financials.internalCost30d),
    },
    integrations: {
      googleAds: { status: integrationStatus(integrations.googleAds, "NOT_CONNECTED") },
      whatsapp: { status: integrationStatus(integrations.whatsapp, "DISABLED") },
      payments: { status: integrationStatus(integrations.payments, "MANUAL_ONLY") },
    },
  };
}