import { getDb } from "@/lib/db";
import type { DbDriver } from "@/lib/db/types";
import type { OfferItemRow, OfferRow, OfferStatus, OfferWithItems } from "@/lib/domain/types";
import { nowIso } from "@/lib/core/date";

import { clean, findRowById, insertRow, updateRow } from "./base";

export async function createOffer(
  data: Partial<OfferRow> & { customer_id: string; code: string },
  db?: DbDriver,
): Promise<OfferRow> {
  const timestamp = nowIso();
  const row: OfferRow = {
    id: data.id ?? crypto.randomUUID(),
    code: data.code,
    customer_id: data.customer_id,
    project_id: data.project_id ?? null,
    status: data.status ?? "DRAFT",
    currency: data.currency ?? "USD",
    subtotal_minor: data.subtotal_minor === undefined ? 0 : data.subtotal_minor,
    discount_minor: data.discount_minor ?? 0,
    total_minor: data.total_minor === undefined ? 0 : data.total_minor,
    internal_cost_minor: data.internal_cost_minor ?? 0,
    margin_pct: data.margin_pct ?? null,
    valid_until: data.valid_until ?? null,
    pricing_reason: data.pricing_reason ?? null,
    pricing_breakdown: data.pricing_breakdown ?? null,
    client_note: data.client_note ?? null,
    internal_note: data.internal_note ?? null,
    created_by_agent: data.created_by_agent ?? null,
    created_by_user_id: data.created_by_user_id ?? null,
    approved_at: data.approved_at ?? null,
    rejected_at: data.rejected_at ?? null,
    is_demo: data.is_demo ?? 0,
    created_at: timestamp,
    updated_at: timestamp,
  };
  await insertRow("offers", row, db);
  return row;
}

export async function updateOffer(
  id: string,
  data: Partial<OfferRow>,
  db?: DbDriver,
): Promise<OfferRow | undefined> {
  return updateRow<OfferRow>("offers", id, { ...clean(data), updated_at: nowIso() }, db);
}

export async function findOfferById(
  id: string,
  options: { withItems?: boolean } = {},
  db?: DbDriver,
): Promise<OfferWithItems | undefined> {
  const driver = db ?? (await getDb());
  const offer = await driver.get<OfferRow>(
    `SELECT o.*, c.contact_name AS customer_name FROM offers o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?`,
    [id],
  );
  if (!offer) return undefined;
  const items = options.withItems === false ? [] : await listOfferItems(id, driver);
  return { ...(offer as OfferWithItems), items };
}

export async function listOffers(
  filter: { customerId?: string; status?: OfferStatus[]; limit?: number; offset?: number } = {},
  db?: DbDriver,
): Promise<{ rows: OfferWithItems[]; total: number }> {
  const driver = db ?? (await getDb());
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (filter.customerId) {
    clauses.push("o.customer_id = ?");
    params.push(filter.customerId);
  }
  if (filter.status?.length) {
    clauses.push(`o.status IN (${filter.status.map(() => "?").join(", ")})`);
    params.push(...filter.status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const totalRow = await driver.get<{ total: number }>(
    `SELECT COUNT(*) AS total FROM offers o ${where}`,
    params,
  );
  const offers = await driver.query<OfferRow & { customer_name: string | null }>(
    `SELECT o.*, c.contact_name AS customer_name
     FROM offers o JOIN customers c ON c.id = o.customer_id
     ${where} ORDER BY o.created_at DESC LIMIT ? OFFSET ?`,
    [...params, filter.limit ?? 50, filter.offset ?? 0],
  );

  const rows: OfferWithItems[] = [];
  for (const offer of offers) {
    rows.push({ ...offer, items: await listOfferItems(offer.id, driver) });
  }
  return { rows, total: Number(totalRow?.total ?? 0) };
}

export async function listOfferCodes(db?: DbDriver): Promise<string[]> {
  const driver = db ?? (await getDb());
  const rows = await driver.query<{ code: string }>("SELECT code FROM offers");
  return rows.map((row) => row.code);
}

export async function addOfferItem(
  data: Partial<OfferItemRow> & { offer_id: string; description_ar: string },
  db?: DbDriver,
): Promise<OfferItemRow> {
  const row: OfferItemRow = {
    id: data.id ?? crypto.randomUUID(),
    offer_id: data.offer_id,
    service_id: data.service_id ?? null,
    description_ar: data.description_ar,
    description_en: data.description_en ?? null,
    quantity: data.quantity ?? 1,
    unit_price_minor: data.unit_price_minor ?? 0,
    billing_type: data.billing_type ?? "ONE_TIME",
    months: data.months ?? null,
    total_minor: data.total_minor ?? 0,
    sort_order: data.sort_order ?? 0,
  };
  await insertRow("offer_items", row, db);
  return row;
}

export async function listOfferItems(offerId: string, db?: DbDriver): Promise<OfferItemRow[]> {
  const driver = db ?? (await getDb());
  return driver.query<OfferItemRow>(
    "SELECT * FROM offer_items WHERE offer_id = ? ORDER BY sort_order, id",
    [offerId],
  );
}

export async function deleteOfferItems(offerId: string, db?: DbDriver): Promise<void> {
  const driver = db ?? (await getDb());
  await driver.run("DELETE FROM offer_items WHERE offer_id = ?", [offerId]);
}

export async function listExpiredSentOffers(reference = nowIso(), db?: DbDriver): Promise<OfferRow[]> {
  const driver = db ?? (await getDb());
  return driver.query<OfferRow>(
    "SELECT * FROM offers WHERE status = 'SENT' AND valid_until IS NOT NULL AND valid_until < ?",
    [reference],
  );
}

export async function countOffersByStatus(db?: DbDriver): Promise<Record<string, number>> {
  const driver = db ?? (await getDb());
  const rows = await driver.query<{ status: string; total: number }>(
    "SELECT status, COUNT(*) AS total FROM offers GROUP BY status",
  );
  return Object.fromEntries(rows.map((row) => [row.status, Number(row.total)]));
}
