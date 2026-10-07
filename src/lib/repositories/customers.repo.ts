import { getDb } from "@/lib/db";
import type { DbDriver } from "@/lib/db/types";
import type { CustomerFactRow, CustomerRow, CustomerStatus, Locale } from "@/lib/domain/types";
import { nowIso } from "@/lib/core/date";

import { type Dict, clean, findRowById, insertRow, likePattern, updateRow } from "./base";

export interface CustomerFilter {
  search?: string;
  status?: CustomerStatus;
  limit?: number;
  offset?: number;
}

export async function createCustomer(
  data: Partial<CustomerRow> & { contact_name: string },
  db?: DbDriver,
): Promise<CustomerRow> {
  const timestamp = nowIso();
  const row: CustomerRow = {
    id: data.id ?? crypto.randomUUID(),
    user_id: data.user_id ?? null,
    company_name: data.company_name ?? null,
    contact_name: data.contact_name,
    email: data.email ?? null,
    phone: data.phone ?? null,
    country: data.country ?? null,
    city: data.city ?? null,
    locale: (data.locale ?? "ar") as Locale,
    currency: data.currency ?? "USD",
    timezone: data.timezone ?? null,
    source: data.source ?? null,
    status: data.status ?? "LEAD",
    goals: data.goals ?? null,
    needs: data.needs ?? null,
    ai_summary: data.ai_summary ?? null,
    internal_notes: data.internal_notes ?? null,
    owner_user_id: data.owner_user_id ?? null,
    is_demo: data.is_demo ?? 0,
    created_at: timestamp,
    updated_at: timestamp,
  };
  await insertRow("customers", row as unknown as Dict, db);
  return row;
}

export async function updateCustomer(
  id: string,
  data: Partial<CustomerRow>,
  db?: DbDriver,
): Promise<CustomerRow | undefined> {
  return updateRow<CustomerRow>("customers", id, { ...clean(data as never), updated_at: nowIso() }, db);
}

export async function findCustomerById(id: string, db?: DbDriver): Promise<CustomerRow | undefined> {
  return findRowById<CustomerRow>("customers", id, db);
}

export async function findCustomerByUserId(
  userId: string,
  db?: DbDriver,
): Promise<CustomerRow | undefined> {
  const driver = db ?? (await getDb());
  return driver.get<CustomerRow>("SELECT * FROM customers WHERE user_id = ?", [userId]);
}

export async function findCustomerByEmail(email: string, db?: DbDriver): Promise<CustomerRow | undefined> {
  const driver = db ?? (await getDb());
  return driver.get<CustomerRow>(
    "SELECT * FROM customers WHERE email = ? COLLATE NOCASE ORDER BY created_at LIMIT 1",
    [email.toLowerCase()],
  );
}

export async function listCustomers(
  filter: CustomerFilter = {},
  db?: DbDriver,
): Promise<{ rows: CustomerRow[]; total: number }> {
  const driver = db ?? (await getDb());
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (filter.status) {
    clauses.push("status = ?");
    params.push(filter.status);
  }
  if (filter.search) {
    clauses.push(
      "(contact_name LIKE ? ESCAPE '\\' OR company_name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\')",
    );
    const pattern = likePattern(filter.search);
    params.push(pattern, pattern, pattern, pattern);
  }

  const where = clauses.length ? clauses.join(" AND ") : "1 = 1";
  const totalRow = await driver.get<{ total: number }>(
    `SELECT COUNT(*) AS total FROM customers WHERE ${where}`,
    params,
  );
  const rows = await driver.query<CustomerRow>(
    `SELECT * FROM customers WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, filter.limit ?? 50, filter.offset ?? 0],
  );
  return { rows, total: Number(totalRow?.total ?? 0) };
}

export async function setCustomerStatus(
  id: string,
  status: CustomerStatus,
  db?: DbDriver,
): Promise<void> {
  const driver = db ?? (await getDb());
  await driver.run("UPDATE customers SET status = ?, updated_at = ? WHERE id = ?", [status, nowIso(), id]);
}

/* ------------------------------------------------------------------- facts --- */

/** Upserts a fact, upgrading `verified` when staff confirms an AI-guessed value. */
export async function upsertCustomerFact(
  data: {
    customer_id: string;
    fact_key: string;
    fact_value: string;
    source: CustomerFactRow["source"];
    confidence?: number;
    verified?: boolean;
    recorded_by?: string | null;
  },
  db?: DbDriver,
): Promise<void> {
  const driver = db ?? (await getDb());
  const existing = await driver.get<CustomerFactRow>(
    "SELECT * FROM customer_facts WHERE customer_id = ? AND fact_key = ?",
    [data.customer_id, data.fact_key],
  );
  const timestamp = nowIso();
  if (existing) {
    await driver.run(
      "UPDATE customer_facts SET fact_value = ?, source = ?, confidence = ?, verified = ?, recorded_by = ?, updated_at = ? WHERE id = ?",
      [
        data.fact_value,
        data.source,
        data.confidence ?? 1,
        data.verified ? 1 : existing.verified,
        data.recorded_by ?? existing.recorded_by,
        timestamp,
        existing.id,
      ],
    );
    return;
  }
  await insertRow(
    "customer_facts",
    {
      id: crypto.randomUUID(),
      customer_id: data.customer_id,
      fact_key: data.fact_key,
      fact_value: data.fact_value,
      source: data.source,
      confidence: data.confidence ?? 1,
      verified: data.verified ? 1 : 0,
      recorded_by: data.recorded_by ?? null,
      created_at: timestamp,
      updated_at: timestamp,
    },
    db,
  );
}

export async function listCustomerFacts(customerId: string, db?: DbDriver): Promise<CustomerFactRow[]> {
  const driver = db ?? (await getDb());
  return driver.query<CustomerFactRow>(
    "SELECT * FROM customer_facts WHERE customer_id = ? ORDER BY fact_key",
    [customerId],
  );
}

export async function factsToMap(customerId: string, db?: DbDriver): Promise<Record<string, string>> {
  const facts = await listCustomerFacts(customerId, db);
  return Object.fromEntries(facts.map((fact) => [fact.fact_key, fact.fact_value]));
}

export async function deleteCustomerFact(
  customerId: string,
  factKey: string,
  db?: DbDriver,
): Promise<void> {
  const driver = db ?? (await getDb());
  await driver.run("DELETE FROM customer_facts WHERE customer_id = ? AND fact_key = ?", [
    customerId,
    factKey,
  ]);
}
