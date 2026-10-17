import { addDays, nowIso, toDateKey } from "@/lib/core/date";
import { assertSameCurrency, formatMoney } from "@/lib/core/money";
import type { CustomerRow, Locale } from "@/lib/domain/types";
import { getDb } from "@/lib/db";
import {
  agentActionStats,
  agentPerformance,
  countPendingAgentActions,
  listAgentActions,
} from "@/lib/repositories/agents.repo";
import { countSubscriptionsByStatus, listInvoices, listPayments, sumSucceededPayments } from "@/lib/repositories/billing.repo";
import { findCustomerById, listCustomers } from "@/lib/repositories/customers.repo";
import { countAlertsBySeverity, listAlerts } from "@/lib/repositories/governance.repo";
import { countOffersByStatus, listOffers } from "@/lib/repositories/offers.repo";
import {
  aggregateMetrics,
  campaignSpendByCustomer,
  listActiveCampaigns,
  listCampaigns,
  listRecentCampaignChanges,
} from "@/lib/repositories/growth.repo";
import { listActivities } from "@/lib/repositories/governance.repo";
import {
  countProjectsByStatus,
  listOverdueProjects,
  listProjects,
  listProjectTasks,
} from "@/lib/repositories/projects.repo";
import { listReports } from "@/lib/repositories/growth.repo";
import { listConversations } from "@/lib/repositories/messaging.repo";
import { reviewStats } from "@/lib/repositories/governance.repo";

import { getAgencySettings } from "./settings.service";

/**
 * Dashboard aggregation.
 *
 * Two audiences, two shapes:
 *  - `staffOverview()` powers the central control dashboard for the owner and the
 *    partner: clients, requests, projects (including late ones), agent-generated
 *    offers, items needing intervention, campaigns, ad spend, reports, alerts,
 *    agent performance, recent actions, payments/subscriptions and the internal
 *    revenue/cost/margin picture.
 *  - `clientOverview()` powers the client portal and NEVER exposes internal
 *    costs, margins, other clients' data or agency revenue.
 */

export interface StaffOverview {
  generatedAt: string;
  clients: {
    total: number;
    newThisWeek: number;
    leads: number;
    active: number;
  };
  projects: {
    total: number;
    byStatus: Record<string, number>;
    active: number;
    late: { id: string; code: string; title: string; dueDate: string; customer: string | null }[];
    recentlyUpdated: { id: string; code: string; title: string; status: string; progress: number }[];
  };
  requests: {
    newOffers: { id: string; code: string; totalMinor: number | null; currency: string; customer: string | null; createdByAgent: string | null; createdAt: string }[];
    pendingOffers: number;
    approvedOffers: number;
    awaitingClient: number;
  };
  interventions: {
    pendingAgentActions: number;
    agentActions: { id: string; agentKey: string; summary: string; riskLevel: string; createdAt: string }[];
    unreadConversations: number;
    overdueInvoices: number;
  };
  campaigns: {
    active: number;
    total: number;
    spend30d: { currency: string; totalMinor: number }[];
    recentChanges: { id: string; campaignName: string | null; customerName: string | null; changeType: string; reason: string | null; createdAt: string; autoApplied: number }[];
  };
  money: {
    collected30d: { currency: string; totalMinor: number }[];
    outstanding: { currency: string; totalMinor: number }[];
    internalCost30d: { currency: string; totalMinor: number }[];
    marginPercent: number | null;
    subscriptionsByStatus: Record<string, number>;
    recentPayments: { id: string; amountMinor: number; currency: string; method: string; status: string; createdAt: string }[];
  };
  alerts: {
    counts: Record<string, number>;
    items: { id: string; severity: string; titleAr: string; titleEn: string; createdAt: string; category: string }[];
  };
  agents: {
    performance: { agentKey: string; runs: number; failures: number; avgLatencyMs: number; lastRunAt: string | null }[];
    actions: { agentKey: string; actions: number; highRisk: number }[];
  };
  reports: {
    recent: { id: string; title: string; type: string; status: string; createdAt: string }[];
    total30d: number;
  };
  activity: { id: string; actorType: string; actorLabel: string | null; action: string; summary: string | null; createdAt: string }[];
  reviews: { average: number | null; count: number };
}

export async function staffOverview(): Promise<StaffOverview> {
  const since7d = addDays(new Date(), -7).toISOString();
  const since30d = addDays(new Date(), -30).toISOString();

  const [
    customersAll,
    customersNew,
    projectsByStatus,
    lateProjects,
    recentProjects,
    offersNew,
    offersByStatus,
    pendingAgentActions,
    agentActionList,
    conversations,
    campaignsActive,
    campaignsAll,
    spendByCustomer,
    recentChanges,
    payments30d,
    invoicesActive,
    subscriptionsByStatus,
    recentPayments,
    alertCountsValue,
    alertList,
    agentPerf,
    agentStats,
    reports30d,
    activities,
    reviews,
  ] = await Promise.all([
    listCustomers({ limit: 1 }),
    listCustomers({ limit: 1 }).then(() => countCustomersSince(since7d)),
    countProjectsByStatus(),
    listOverdueProjects(8),
    listProjects({ limit: 6 }),
    listOffers({ status: ["DRAFT", "SENT"], limit: 8 }),
    countOffersByStatus(),
    countPendingAgentActions(),
    listAgentActions({ limit: 8 }),
    listConversations({ unreadForStaff: true, limit: 1 }),
    listActiveCampaigns(),
    listCampaigns({ limit: 1 }),
    campaignSpendByCustomer(since30d.slice(0, 10)),
    listRecentCampaignChanges(since30d, 6),
    sumSucceededPayments(since30d),
    listInvoices({ status: ["ISSUED", "OVERDUE", "PARTIALLY_PAID"], limit: 200 }),
    countSubscriptionsByStatus(),
    listPayments({ limit: 6 }),
    countAlertsBySeverity(),
    listAlerts({ status: ["NEW", "ACKNOWLEDGED"], limit: 8 }),
    agentPerformance(since30d),
    agentActionStats(since30d),
    listReports({ limit: 200 }),
    listActivities({ limit: 12 }),
    reviewStats(),
  ]);

  const collectedByCurrency = new Map<string, number>();
  for (const row of payments30d) {
    collectedByCurrency.set(row.currency, (collectedByCurrency.get(row.currency) ?? 0) + row.total_minor);
  }

  const outstandingByCurrency = new Map<string, number>();
  for (const invoice of invoicesActive.rows) {
    const remaining = invoice.total_minor - invoice.amount_paid_minor;
    if (remaining <= 0) continue;
    outstandingByCurrency.set(
      invoice.currency,
      (outstandingByCurrency.get(invoice.currency) ?? 0) + remaining,
    );
  }

  const spendByCurrency = new Map<string, number>();
  for (const row of spendByCustomer) {
    spendByCurrency.set(row.currency, (spendByCurrency.get(row.currency) ?? 0) + row.spent_minor);
  }

  // Internal picture: what work cost us vs. what it earned (staff-only).
  const db = await getDb();
  const costRow = await db.get<{ total: number | null }>(
    `SELECT SUM(internal_cost_minor) AS total FROM projects WHERE created_at >= ? AND status <> 'CANCELLED'`,
    [since30d],
  );
  const revenueRow = await db.get<{ total: number | null }>(
    `SELECT SUM(amount_paid_minor) AS total FROM invoices WHERE updated_at >= ?`,
    [since30d],
  );
  const internalCost = Number(costRow?.total ?? 0);
  const revenue = Number(revenueRow?.total ?? 0);
  const marginPercent = revenue > 0 ? Number((((revenue - internalCost) / revenue) * 100).toFixed(1)) : null;

  const reports = reports30d.rows.filter((report) => report.created_at >= since30d);

  return {
    generatedAt: nowIso(),
    clients: {
      total: customersAll.total,
      newThisWeek: customersNew,
      leads: await countCustomersWithStatus("LEAD"),
      active: await countCustomersWithStatus("ACTIVE"),
    },
    projects: {
      total: Object.values(projectsByStatus).reduce((total, value) => total + value, 0),
      byStatus: projectsByStatus,
      active:
        (projectsByStatus.IN_PROGRESS ?? 0) +
        (projectsByStatus.PLANNING ?? 0) +
        (projectsByStatus.IN_REVIEW ?? 0) +
        (projectsByStatus.REVISIONS ?? 0),
      late: lateProjects.map((project) => ({
        id: project.id,
        code: project.code,
        title: project.title,
        dueDate: project.due_date ?? "",
        customer: project.customer_name,
      })),
      recentlyUpdated: recentProjects.rows.map((project) => ({
        id: project.id,
        code: project.code,
        title: project.title,
        status: project.status,
        progress: project.progress,
      })),
    },
    requests: {
      newOffers: offersNew.rows.map((offer) => ({
        id: offer.id,
        code: offer.code,
        totalMinor: offer.total_minor,
        currency: offer.currency,
        customer: offer.customer_name ?? null,
        createdByAgent: offer.created_by_agent,
        createdAt: offer.created_at,
      })),
      pendingOffers: (offersByStatus.DRAFT ?? 0) + (offersByStatus.SENT ?? 0),
      approvedOffers: offersByStatus.APPROVED ?? 0,
      awaitingClient: offersByStatus.SENT ?? 0,
    },
    interventions: {
      pendingAgentActions,
      agentActions: agentActionList.rows.map((action) => ({
        id: action.id,
        agentKey: action.agent_key,
        summary: action.summary,
        riskLevel: action.risk_level,
        createdAt: action.created_at,
      })),
      unreadConversations: conversations.total,
      overdueInvoices: invoicesActive.rows.filter((invoice) => invoice.status === "OVERDUE").length,
    },
    campaigns: {
      active: campaignsActive.length,
      total: campaignsAll.total,
      spend30d: [...spendByCurrency.entries()].map(([currency, totalMinor]) => ({ currency, totalMinor })),
      recentChanges: recentChanges.map((change) => ({
        id: change.id,
        campaignName: change.campaign_name,
        customerName: change.customer_name,
        changeType: change.change_type,
        reason: change.reason,
        createdAt: change.created_at,
        autoApplied: change.auto_applied,
      })),
    },
    money: {
      collected30d: [...collectedByCurrency.entries()].map(([currency, totalMinor]) => ({ currency, totalMinor })),
      outstanding: [...outstandingByCurrency.entries()].map(([currency, totalMinor]) => ({ currency, totalMinor })),
      internalCost30d: internalCost > 0 ? [{ currency: "USD", totalMinor: internalCost }] : [],
      marginPercent,
      subscriptionsByStatus,
      recentPayments: recentPayments.rows.map((payment) => ({
        id: payment.id,
        amountMinor: payment.amount_minor,
        currency: payment.currency,
        method: payment.method,
        status: payment.status,
        createdAt: payment.created_at,
      })),
    },
    alerts: {
      counts: alertCountsValue,
      items: alertList.rows.map((alert) => ({
        id: alert.id,
        severity: alert.severity,
        titleAr: alert.title_ar,
        titleEn: alert.title_en,
        createdAt: alert.created_at,
        category: alert.category,
      })),
    },
    agents: {
      performance: agentPerf.map((row) => ({
        agentKey: row.agent_key,
        runs: row.runs,
        failures: row.failures,
        avgLatencyMs: row.avg_latency_ms,
        lastRunAt: row.last_run_at,
      })),
      actions: agentStats.map((row) => ({
        agentKey: row.agent_key,
        actions: row.actions,
        highRisk: row.high_risk,
      })),
    },
    reports: {
      recent: reports.slice(0, 6).map((report) => ({
        id: report.id,
        title: report.title,
        type: report.report_type,
        status: report.status,
        createdAt: report.created_at,
      })),
      total30d: reports.length,
    },
    activity: activities.rows.map((entry) => ({
      id: entry.id,
      actorType: entry.actor_type,
      actorLabel: entry.actor_label,
      action: entry.action,
      summary: entry.summary,
      createdAt: entry.created_at,
    })),
    reviews,
  };
}

async function countCustomersSince(sinceIso: string): Promise<number> {
  const db = await getDb();
  const row = await db.get<{ total: number }>(
    "SELECT COUNT(*) AS total FROM customers WHERE created_at >= ?",
    [sinceIso],
  );
  return Number(row?.total ?? 0);
}

async function countCustomersWithStatus(status: string): Promise<number> {
  const db = await getDb();
  const row = await db.get<{ total: number }>(
    "SELECT COUNT(*) AS total FROM customers WHERE status = ?",
    [status],
  );
  return Number(row?.total ?? 0);
}

/* ------------------------------------------------------------ client portal -- */

export interface ClientOverview {
  customerId: string;
  companyName: string | null;
  projectCount: number;
  activeProjects: { id: string; code: string; title: string; status: string; progress: number; dueDate: string | null }[];
  pendingOffers: { id: string; code: string; totalMinor: number | null; currency: string; status: string; validUntil: string | null }[];
  billing: { outstandingMinor: number; currency: string; paidMinor: number; nextRenewal: { planName: string; date: string } | null };
  unreadMessages: number;
  reports: { id: string; title: string; createdAt: string; type: string }[];
  campaigns: { id: string; name: string; platform: string; status: string; spentMinor: number; budgetMinor: number; currency: string }[];
  reviewPrompt: { projectId: string; projectTitle: string } | null;
}

export async function clientOverview(customer: CustomerRow): Promise<ClientOverview> {
  const [projects, offers, campaigns, invoices, reports, conversations, subscriptions, reviewData] = await Promise.all([
    listProjects({ customerId: customer.id, limit: 50 }),
    listOffers({ customerId: customer.id, status: ["SENT", "DRAFT"], limit: 10 }),
    listCampaigns({ customerId: customer.id, limit: 20 }),
    listInvoices({ customerId: customer.id, limit: 100 }),
    listReports({ customerId: customer.id, limit: 10 }),
    listConversations({ customerId: customer.id, limit: 5 }),
    (await import("@/lib/repositories/billing.repo")).listSubscriptions({ customerId: customer.id, limit: 20 }),
    reviewStatsForCustomer(customer.id),
  ]);

  const activeStatuses = ["PLANNING", "IN_PROGRESS", "IN_REVIEW", "REVISIONS", "AWAITING_PAYMENT"];
  const active = projects.rows.filter((project) => activeStatuses.includes(project.status));
  const completed = projects.rows.filter((project) => project.status === "COMPLETED");

  const currency = invoices.rows[0]?.currency ?? customer.currency;
  const outstanding = invoices.rows
    .filter((invoice) => ["ISSUED", "OVERDUE", "PARTIALLY_PAID"].includes(invoice.status))
    .reduce((total, invoice) => total + (invoice.total_minor - invoice.amount_paid_minor), 0);
  const paid = invoices.rows.reduce((total, invoice) => total + invoice.amount_paid_minor, 0);

  const nextRenewal = subscriptions.rows
    .filter((row) => row.next_renewal_at && row.cancel_at_period_end !== 1 && row.status === "ACTIVE")
    .sort((a, b) => (a.next_renewal_at! < b.next_renewal_at! ? -1 : 1))[0];

  const unreviewed = completed.find((project) => !reviewData.includes(project.id));

  return {
    customerId: customer.id,
    companyName: customer.company_name,
    projectCount: projects.total,
    activeProjects: active.slice(0, 5).map((project) => ({
      id: project.id,
      code: project.code,
      title: project.title,
      status: project.status,
      progress: project.progress,
      dueDate: project.due_date,
    })),
    pendingOffers: offers.rows.map((offer) => ({
      id: offer.id,
      code: offer.code,
      totalMinor: offer.total_minor,
      currency: offer.currency,
      status: offer.status,
      validUntil: offer.valid_until,
    })),
    billing: {
      outstandingMinor: Math.max(0, outstanding),
      currency,
      paidMinor: paid,
      nextRenewal: nextRenewal
        ? { planName: nextRenewal.plan_name, date: nextRenewal.next_renewal_at! }
        : null,
    },
    unreadMessages: conversations.rows.reduce((total, row) => total + row.unread_for_client, 0),
    reports: reports.rows.map((report) => ({
      id: report.id,
      title: report.title,
      createdAt: report.created_at,
      type: report.report_type,
    })),
    campaigns: campaigns.rows.map((campaign) => ({
      id: campaign.id,
      name: campaign.name,
      platform: campaign.platform,
      status: campaign.status,
      spentMinor: campaign.spent_minor,
      budgetMinor: campaign.total_budget_minor,
      currency: campaign.currency,
    })),
    reviewPrompt: unreviewed ? { projectId: unreviewed.id, projectTitle: unreviewed.title } : null,
  };
}

async function reviewStatsForCustomer(customerId: string): Promise<string[]> {
  const db = await getDb();
  const rows = await db.query<{ project_id: string | null }>(
    "SELECT project_id FROM reviews WHERE customer_id = ?",
    [customerId],
  );
  return rows.map((row) => row.project_id).filter((id): id is string => Boolean(id));
}

/** Formats a money list for dashboards without mixing currencies. */
export function describeMoneyList(
  items: { currency: string; totalMinor: number }[],
  locale: Locale = "ar",
): string {
  if (items.length === 0) return formatMoney(0, "USD", locale);
  if (items.length === 1) {
    const entry = items[0]!;
    return formatMoney(entry.totalMinor, entry.currency, locale);
  }
  const single = assertSameCurrency(items);
  if (single) {
    const total = items.reduce((sum, item) => sum + item.totalMinor, 0);
    return formatMoney(total, single, locale);
  }
  return items
    .map((item) => formatMoney(item.totalMinor, item.currency, locale))
    .join(" · ");
}

/** Fresh client snapshot for the assistant and notifications. */
export async function clientSnapshot(customerId: string): Promise<CustomerRow | undefined> {
  return findCustomerById(customerId);
}

export async function todayDateKey(): Promise<string> {
  return toDateKey(new Date());
}

export async function recentProjectTasks(projectId: string) {
  return listProjectTasks(projectId, { includeInternal: true });
}

export async function totalAdSpend30d(): Promise<number> {
  const totals = await aggregateMetrics({ fromDate: addDays(new Date(), -30).toISOString().slice(0, 10) });
  return totals.cost_minor;
}
