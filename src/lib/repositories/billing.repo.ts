import { getDb } from "@/lib/db";
import type { DbDriver } from "@/lib/db/types";
import type {
  InvoiceRow,
  InvoiceStatus,
  InvoiceWithCustomer,
  PaymentRow,
  PaymentStatus,
  SubscriptionRow,
  SubscriptionStatus,
} from "@/lib/domain/types";
import { nowIso } from "@/lib/core/date";

import { clean, findRowById, insertRow, updateRow } from "./base";

/* ----------------------------------------------------------------- invoices */

export async function createInvoice(
  data: Partial<InvoiceRow> & { customer_id: string; number: string },
  db?: DbDriver,
): Promise<InvoiceRow> {
  const timestamp = nowIso();
  const row: InvoiceRow = {
    id: data.id ?? crypto.randomUUID(),
    number: data.number,
    customer_id: data.customer_id,
    project_id: data.project_id ?? null,
    offer_id: data.offer_id ?? null,
    subscription_id: data.subscription_id ?? null,
    currency: data.currency ?? "USD",
    subtotal_minor: data.subtotal_minor ?? 0,
    tax_minor: data.tax_minor ?? 0,
    total_minor: data.total_minor ?? 0,
    amount_paid_minor: data.amount_paid_minor ?? 0,
    refunded_minor: data.refunded_minor ?? 0,
    status: data.status ?? "DRAFT",
    issued_at: data.issued_at ?? null,
    due_at: data.due_at ?? null,
    paid_at: data.paid_at ?? null,
    notes_client: data.notes_client ?? null,
    internal_note: data.internal_note ?? null,
    policy_snapshot: data.policy_snapshot ?? null,
    is_demo: data.is_demo ?? 0,
    created_at: timestamp,
    updated_at: timestamp,
  };
  await insertRow("invoices", row, db);
  return row;
}

export async function updateInvoice(
  id: string,
  data: Partial<InvoiceRow>,
  db?: DbDriver,
): Promise<InvoiceRow | undefined> {
  return updateRow<InvoiceRow>("invoices", id, { ...clean(data), updated_at: nowIso() }, db);
}

export async function findInvoiceById(id: string, db?: DbDriver): Promise<InvoiceWithCustomer | undefined> {
  const driver = db ?? (await getDb());
  return driver.get<InvoiceWithCustomer>(
    `SELECT i.*, c.contact_name AS customer_name
     FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.id = ?`,
    [id],
  );
}

export async function listInvoices(
  filter: {
    customerId?: string;
    status?: InvoiceStatus[];
    limit?: number;
    offset?: number;
    dueBefore?: string;
  } = {},
  db?: DbDriver,
): Promise<{ rows: InvoiceWithCustomer[]; total: number }> {
  const driver = db ?? (await getDb());
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (filter.customerId) {
    clauses.push("i.customer_id = ?");
    params.push(filter.customerId);
  }
  if (filter.status?.length) {
    clauses.push(`i.status IN (${filter.status.map(() => "?").join(", ")})`);
    params.push(...filter.status);
  }
  if (filter.dueBefore) {
    clauses.push("i.due_at IS NOT NULL AND i.due_at < ?");
    params.push(filter.dueBefore);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const totalRow = await driver.get<{ total: number }>(
    `SELECT COUNT(*) AS total FROM invoices i ${where}`,
    params,
  );
  const rows = await driver.query<InvoiceWithCustomer>(
    `SELECT i.*, c.contact_name AS customer_name
     FROM invoices i JOIN customers c ON c.id = i.customer_id
     ${where} ORDER BY i.created_at DESC LIMIT ? OFFSET ?`,
    [...params, filter.limit ?? 50, filter.offset ?? 0],
  );
  return { rows, total: Number(totalRow?.total ?? 0) };
}

export async function listInvoiceNumbers(db?: DbDriver): Promise<string[]> {
  const driver = db ?? (await getDb());
  const rows = await driver.query<{ number: string }>("SELECT number FROM invoices");
  return rows.map((row) => row.number);
}

/** Invoices that are issued, unpaid and past their due date. */
export async function listOverdueInvoices(reference = nowIso(), db?: DbDriver): Promise<InvoiceWithCustomer[]> {
  const driver = db ?? (await getDb());
  return driver.query<InvoiceWithCustomer>(
    `SELECT i.*, c.contact_name AS customer_name
     FROM invoices i JOIN customers c ON c.id = i.customer_id
     WHERE i.status IN ('ISSUED', 'PARTIALLY_PAID') AND i.due_at IS NOT NULL AND i.due_at < ?
     ORDER BY i.due_at ASC`,
    [reference],
  );
}

/* ----------------------------------------------------------------- payments */

export async function createPayment(
  data: Partial<PaymentRow> & { customer_id: string; amount_minor: number },
  db?: DbDriver,
): Promise<PaymentRow> {
  const timestamp = nowIso();
  const row: PaymentRow = {
    id: data.id ?? crypto.randomUUID(),
    invoice_id: data.invoice_id ?? null,
    customer_id: data.customer_id,
    subscription_id: data.subscription_id ?? null,
    amount_minor: data.amount_minor,
    refunded_minor: data.refunded_minor ?? 0,
    currency: data.currency ?? "USD",
    method: data.method ?? "MANUAL_TRANSFER",
    provider: data.provider ?? "manual",
    provider_ref: data.provider_ref ?? null,
    status: data.status ?? "PENDING",
    paid_at: data.paid_at ?? null,
    recorded_by_user_id: data.recorded_by_user_id ?? null,
    note: data.note ?? null,
    is_demo: data.is_demo ?? 0,
    created_at: timestamp,
    updated_at: timestamp,
  };
  await insertRow("payments", row, db);
  return row;
}

export async function updatePayment(
  id: string,
  data: Partial<PaymentRow>,
  db?: DbDriver,
): Promise<PaymentRow | undefined> {
  return updateRow<PaymentRow>("payments", id, { ...clean(data), updated_at: nowIso() }, db);
}

export async function findPaymentById(id: string, db?: DbDriver): Promise<PaymentRow | undefined> {
  return findRowById<PaymentRow>("payments", id, db);
}

export async function findPaymentByProviderRef(
  provider: string,
  providerRef: string,
  db?: DbDriver,
): Promise<PaymentRow | undefined> {
  const driver = db ?? (await getDb());
  return driver.get<PaymentRow>("SELECT * FROM payments WHERE provider = ? AND provider_ref = ?", [
    provider,
    providerRef,
  ]);
}

export async function listPayments(
  filter: { customerId?: string; status?: PaymentStatus[]; limit?: number; offset?: number } = {},
  db?: DbDriver,
): Promise<{ rows: PaymentRow[]; total: number }> {
  const driver = db ?? (await getDb());
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (filter.customerId) {
    clauses.push("customer_id = ?");
    params.push(filter.customerId);
  }
  if (filter.status?.length) {
    clauses.push(`status IN (${filter.status.map(() => "?").join(", ")})`);
    params.push(...filter.status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const totalRow = await driver.get<{ total: number }>(
    `SELECT COUNT(*) AS total FROM payments ${where}`,
    params,
  );
  const rows = await driver.query<PaymentRow>(
    `SELECT * FROM payments ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, filter.limit ?? 50, filter.offset ?? 0],
  );
  return { rows, total: Number(totalRow?.total ?? 0) };
}

/** Sum of successfully collected money, per currency. */
export async function sumSucceededPayments(
  sinceIso?: string,
  db?: DbDriver,
): Promise<{ currency: string; total_minor: number }[]> {
  const driver = db ?? (await getDb());
  const params: string[] = [];
  let where = "WHERE status = 'SUCCEEDED'";
  if (sinceIso) {
    where += " AND created_at >= ?";
    params.push(sinceIso);
  }
  const rows = await driver.query<{ currency: string; total_minor: number }>(
    `SELECT currency, SUM(amount_minor - refunded_minor) AS total_minor FROM payments ${where} GROUP BY currency`,
    params,
  );
  return rows.map((row) => ({ currency: row.currency, total_minor: Number(row.total_minor ?? 0) }));
}

/* ------------------------------------------------------------ subscriptions */

export async function createSubscription(
  data: Partial<SubscriptionRow> & { customer_id: string; plan_name: string },
  db?: DbDriver,
): Promise<SubscriptionRow> {
  const timestamp = nowIso();
  const row: SubscriptionRow = {
    id: data.id ?? crypto.randomUUID(),
    customer_id: data.customer_id,
    service_id: data.service_id ?? null,
    project_id: data.project_id ?? null,
    plan_name: data.plan_name,
    amount_minor: data.amount_minor ?? 0,
    currency: data.currency ?? "USD",
    interval: data.interval ?? "MONTHLY",
    interval_count: data.interval_count ?? 1,
    status: data.status ?? "ACTIVE",
    started_at: data.started_at ?? timestamp,
    current_period_start: data.current_period_start ?? timestamp,
    current_period_end: data.current_period_end ?? timestamp,
    next_renewal_at: data.next_renewal_at ?? null,
    auto_renew: data.auto_renew ?? 0,
    cancel_at_period_end: data.cancel_at_period_end ?? 0,
    cancelled_at: data.cancelled_at ?? null,
    cancellation_reason: data.cancellation_reason ?? null,
    policy_snapshot: data.policy_snapshot ?? null,
    is_demo: data.is_demo ?? 0,
    created_at: timestamp,
    updated_at: timestamp,
  };
  await insertRow("subscriptions", row, db);
  return row;
}

export async function updateSubscription(
  id: string,
  data: Partial<SubscriptionRow>,
  db?: DbDriver,
): Promise<SubscriptionRow | undefined> {
  return updateRow<SubscriptionRow>("subscriptions", id, { ...clean(data), updated_at: nowIso() }, db);
}

export async function findSubscriptionById(
  id: string,
  db?: DbDriver,
): Promise<SubscriptionRow | undefined> {
  return findRowById<SubscriptionRow>("subscriptions", id, db);
}

export async function listSubscriptions(
  filter: { customerId?: string; status?: SubscriptionStatus[]; limit?: number; offset?: number } = {},
  db?: DbDriver,
): Promise<{ rows: SubscriptionRow[]; total: number }> {
  const driver = db ?? (await getDb());
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (filter.customerId) {
    clauses.push("customer_id = ?");
    params.push(filter.customerId);
  }
  if (filter.status?.length) {
    clauses.push(`status IN (${filter.status.map(() => "?").join(", ")})`);
    params.push(...filter.status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const totalRow = await driver.get<{ total: number }>(
    `SELECT COUNT(*) AS total FROM subscriptions ${where}`,
    params,
  );
  const rows = await driver.query<SubscriptionRow>(
    `SELECT * FROM subscriptions ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, filter.limit ?? 50, filter.offset ?? 0],
  );
  return { rows, total: Number(totalRow?.total ?? 0) };
}

/** Subscriptions whose paid period has ended and that are still marked active. */
export async function listRenewalsDue(reference = nowIso(), db?: DbDriver): Promise<SubscriptionRow[]> {
  const driver = db ?? (await getDb());
  return driver.query<SubscriptionRow>(
    `SELECT * FROM subscriptions
     WHERE status = 'ACTIVE' AND next_renewal_at IS NOT NULL AND next_renewal_at <= ?
     ORDER BY next_renewal_at ASC`,
    [reference],
  );
}

export async function countSubscriptionsByStatus(db?: DbDriver): Promise<Record<string, number>> {
  const driver = db ?? (await getDb());
  const rows = await driver.query<{ status: string; total: number }>(
    "SELECT status, COUNT(*) AS total FROM subscriptions GROUP BY status",
  );
  return Object.fromEntries(rows.map((row) => [row.status, Number(row.total)]));
}
