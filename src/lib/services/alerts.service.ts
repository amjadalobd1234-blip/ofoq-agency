import { getEnv } from "@/lib/config/env";
import { logger } from "@/lib/core/logger";
import type { AlertRow, AlertSeverity, AlertStatus, UserRow } from "@/lib/domain/types";
import {
  countAlertsBySeverity,
  findAlertById,
  listAlerts,
  raiseAlert as raiseAlertRow,
  updateAlert,
} from "@/lib/repositories/governance.repo";
import { listStaffUsers } from "@/lib/repositories/identity.repo";

import { logActivity } from "./activity.service";
import { notifyUsers } from "./notifications.service";

export interface RaiseAlertInput {
  severity: AlertSeverity;
  category: string;
  title_ar: string;
  title_en: string;
  body_ar?: string | null;
  body_en?: string | null;
  entity_type?: string | null;
  entity_id?: string | null;
  customer_id?: string | null;
  target_role?: AlertRow["target_role"];
  dedupe_key?: string | null;
  meta?: unknown;
  is_demo?: number;
  /** Set to false for purely informational events that should not email staff. */
  notify?: boolean;
}

/**
 * Alert centre.
 *
 * Severity drives delivery, exactly as required by the platform rules:
 *   URGENT    → in-app notification + email to owner/partner immediately.
 *   IMPORTANT → in-app notification + email digest (still sent immediately, but
 *               clearly marked as needing attention rather than instant action).
 *   INFO      → in-app only; recorded so nothing an agent did is invisible.
 *
 * Repeated identical alerts are collapsed through `dedupe_key` so a failing job
 * cannot flood the dashboard.
 */
export async function raiseAlert(input: RaiseAlertInput): Promise<AlertRow> {
  const { alert, created } = await raiseAlertRow({
    severity: input.severity,
    category: input.category,
    title_ar: input.title_ar,
    title_en: input.title_en,
    body_ar: input.body_ar,
    body_en: input.body_en,
    entity_type: input.entity_type,
    entity_id: input.entity_id,
    customer_id: input.customer_id,
    target_role: input.target_role,
    dedupe_key: input.dedupe_key,
    meta: input.meta,
    is_demo: input.is_demo,
  });

  if (!created) return alert;

  try {
    if (input.target_role === "CLIENT") {
      await notifyClientOfAlert(alert);
    } else if (input.notify !== false) {
      await notifyStaffOfAlert(alert);
    }
  } catch (error) {
    logger.error("Alert notification failed", { alertId: alert.id, error });
  }

  await logActivity({
    actor_type: "SYSTEM",
    action: "alert.raised",
    entity_type: "alert",
    entity_id: alert.id,
    customer_id: alert.customer_id,
    summary: `[${alert.severity}] ${alert.title_en}`,
    meta: { category: alert.category, severity: alert.severity },
  });

  return alert;
}

async function notifyStaffOfAlert(alert: AlertRow): Promise<void> {
  const staff = await listStaffUsers();
  const recipients = filterByRole(staff, alert.target_role);
  if (recipients.length === 0) return;

  await notifyUsers(recipients, {
    subject: alert.severity === "URGENT" ? `🔴 ${alert.title_ar}` : alert.title_ar,
    body: alert.body_ar ?? alert.title_ar,
    alertId: alert.id,
    // INFO events stay in-app only.
    email: alert.severity !== "INFO",
    meta: { alertSeverity: alert.severity, category: alert.category },
  });
}

async function notifyClientOfAlert(alert: AlertRow): Promise<void> {
  if (!alert.customer_id) return;
  const { findCustomerById } = await import("@/lib/repositories/customers.repo");
  const customer = await findCustomerById(alert.customer_id);
  if (!customer?.user_id) return;
  const user: UserRow = {
    id: customer.user_id,
    email: customer.email ?? "",
    name: customer.contact_name,
    role: "CLIENT",
    status: "ACTIVE",
    locale: customer.locale,
    phone: customer.phone,
    country: customer.country,
    avatar_url: null,
    google_sub: null,
    password_hash: null,
    email_verified_at: null,
    last_login_at: null,
    is_demo: customer.is_demo,
    created_at: customer.created_at,
    updated_at: customer.updated_at,
  };
  await notifyUsers([user], {
    subject: alert.title_ar,
    body: alert.body_ar ?? alert.title_ar,
    alertId: alert.id,
    email: alert.severity !== "INFO",
  });
}

function filterByRole(staff: UserRow[], role: AlertRow["target_role"]): UserRow[] {
  if (role === "OWNER") return staff.filter((user) => user.role === "OWNER");
  if (role === "PARTNER") return staff.filter((user) => user.role === "PARTNER");
  return staff;
}

export async function acknowledgeAlert(alertId: string, userId: string): Promise<void> {
  await updateAlert(alertId, {
    status: "ACKNOWLEDGED" as AlertStatus,
    acknowledged_by_user_id: userId,
    acknowledged_at: new Date().toISOString(),
  });
  await logActivity({
    actor_type: "USER",
    actor_user_id: userId,
    action: "alert.acknowledged",
    entity_type: "alert",
    entity_id: alertId,
    summary: "اطّلع فريق الوكالة على التنبيه",
    summary_en: "Alert acknowledged by the team",
  });
}

export async function resolveAlert(alertId: string, userId: string, note?: string): Promise<void> {
  const existing = await findAlertById(alertId);
  await updateAlert(alertId, {
    status: "RESOLVED" as AlertStatus,
    resolved_at: new Date().toISOString(),
    meta: note ? JSON.stringify({ resolutionNote: note }) : existing?.meta ?? null,
  });
  await logActivity({
    actor_type: "USER",
    actor_user_id: userId,
    action: "alert.resolved",
    entity_type: "alert",
    entity_id: alertId,
    summary: note?.trim() || "تمت معالجة التنبيه",
    summary_en: "Alert resolved",
  });
}

export async function openAlerts(limit = 20): Promise<AlertRow[]> {
  const { rows } = await listAlerts({ status: ["NEW", "ACKNOWLEDGED"], limit });
  return rows;
}

export async function alertCounts(): Promise<Record<AlertSeverity, number>> {
  return countAlertsBySeverity();
}

/** Convenience wrappers used across the platform for common situations. */
export async function alertProjectLate(params: {
  projectId: string;
  projectCode: string;
  customerId: string;
  dueDate: string;
  daysLate: number;
}): Promise<void> {
  await raiseAlert({
    severity: params.daysLate > 7 ? "URGENT" : "IMPORTANT",
    category: "delivery",
    title_ar: `مشروع متأخر: ${params.projectCode}`,
    title_en: `Late project: ${params.projectCode}`,
    body_ar: `المشروع ${params.projectCode} متأخر ${params.daysLate} يوم عن الموعد المحدد (${params.dueDate.slice(0, 10)}).`,
    body_en: `Project ${params.projectCode} is ${params.daysLate} days past its due date (${params.dueDate.slice(0, 10)}).`,
    entity_type: "project",
    entity_id: params.projectId,
    customer_id: params.customerId,
    dedupe_key: `project-late:${params.projectId}`,
  });
}

export async function alertInvoiceOverdue(params: {
  invoiceId: string;
  invoiceNumber: string;
  customerId: string;
  totalMinor: number;
  dueDate: string;
}): Promise<void> {
  await raiseAlert({
    severity: "IMPORTANT",
    category: "billing",
    title_ar: `فاتورة غير مسددة: ${params.invoiceNumber}`,
    title_en: `Overdue invoice: ${params.invoiceNumber}`,
    body_ar: `الفاتورة ${params.invoiceNumber} تجاوزت تاريخ الاستحقاق (${params.dueDate.slice(0, 10)}).`,
    body_en: `Invoice ${params.invoiceNumber} is past its due date (${params.dueDate.slice(0, 10)}).`,
    entity_type: "invoice",
    entity_id: params.invoiceId,
    customer_id: params.customerId,
    dedupe_key: `invoice-overdue:${params.invoiceId}`,
    meta: { totalMinor: params.totalMinor },
  });
}

export async function alertNeedsHuman(params: {
  reason: string;
  detailAr: string;
  detailEn: string;
  customerId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  severity?: AlertSeverity;
  dedupeKey?: string;
}): Promise<void> {
  await raiseAlert({
    severity: params.severity ?? "IMPORTANT",
    category: "escalation",
    title_ar: "حالة تحتاج تدخلًا بشريًا",
    title_en: "Case requires human attention",
    body_ar: params.detailAr,
    body_en: params.detailEn,
    entity_type: params.entityType ?? null,
    entity_id: params.entityId ?? null,
    customer_id: params.customerId ?? null,
    dedupe_key: params.dedupeKey ?? `escalation:${params.reason}:${params.entityId ?? "none"}`,
    meta: { reason: params.reason },
  });
}

export async function alertIntegrationIssue(provider: string, detail: string): Promise<void> {
  const env = getEnv();
  await raiseAlert({
    severity: "IMPORTANT",
    category: "integration",
    title_ar: `مشكلة في تكامل ${provider}`,
    title_en: `${provider} integration issue`,
    body_ar: detail,
    body_en: detail,
    dedupe_key: `integration:${provider}`,
    meta: { provider, appUrl: env.appUrl },
  });
}
