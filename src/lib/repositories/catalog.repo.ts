import { getDb } from "@/lib/db";
import type { DbDriver } from "@/lib/db/types";
import type { ServiceRow } from "@/lib/domain/types";
import { nowIso } from "@/lib/core/date";

import { clean, findRowById, insertRow, updateRow } from "./base";

export async function listServices(
  options: { activeOnly?: boolean } = {},
  db?: DbDriver,
): Promise<ServiceRow[]> {
  const driver = db ?? (await getDb());
  const where = options.activeOnly ? "WHERE is_active = 1" : "";
  return driver.query<ServiceRow>(`SELECT * FROM services ${where} ORDER BY sort_order, name_en`);
}

export async function findServiceById(id: string, db?: DbDriver): Promise<ServiceRow | undefined> {
  return findRowById<ServiceRow>("services", id, db);
}

export async function findServiceBySlug(slug: string, db?: DbDriver): Promise<ServiceRow | undefined> {
  const driver = db ?? (await getDb());
  return driver.get<ServiceRow>("SELECT * FROM services WHERE slug = ?", [slug]);
}

export async function createService(data: Partial<ServiceRow> & { slug: string; name_ar: string; name_en: string }, db?: DbDriver): Promise<ServiceRow> {
  const timestamp = nowIso();
  const row: ServiceRow = {
    id: data.id ?? crypto.randomUUID(),
    slug: data.slug,
    name_ar: data.name_ar,
    name_en: data.name_en,
    short_ar: data.short_ar ?? null,
    short_en: data.short_en ?? null,
    description_ar: data.description_ar ?? null,
    description_en: data.description_en ?? null,
    category: data.category ?? "general",
    billing_type: data.billing_type ?? "ONE_TIME",
    unit: data.unit ?? "PROJECT",
    base_price_minor: data.base_price_minor ?? 0,
    min_price_minor: data.min_price_minor ?? 0,
    currency: data.currency ?? "USD",
    delivery_days: data.delivery_days ?? 7,
    revisions_included: data.revisions_included ?? 2,
    complexity_factor: data.complexity_factor ?? 1,
    requires_approval_above_minor: data.requires_approval_above_minor ?? null,
    is_active: data.is_active ?? 1,
    sort_order: data.sort_order ?? 0,
    pricing_config: data.pricing_config ?? null,
    cancellation_policy: data.cancellation_policy ?? null,
    created_at: timestamp,
    updated_at: timestamp,
  };
  await insertRow("services", row, db);
  return row;
}

export async function updateService(
  id: string,
  data: Partial<ServiceRow>,
  db?: DbDriver,
): Promise<ServiceRow | undefined> {
  return updateRow<ServiceRow>("services", id, { ...clean(data), updated_at: nowIso() }, db);
}
