/**
 * Shared repository helpers.
 *
 * Repositories are thin, typed data-access modules: they build SQL, map rows and
 * contain no business rules. Business rules live in `src/lib/services/*` so the
 * same logic is reusable from HTTP routes, agents and CLI jobs.
 *
 * `insertRow` / `updateRow` take plain objects whose keys ARE column names; the
 * caller is responsible for passing values of a supported type. Booleans are
 * normalised to 0/1 by the driver layer.
 */
import { getDb } from "@/lib/db";
import type { DbDriver, SqlValue } from "@/lib/db/types";

/** Any row-shaped object; keys are column names. */
export type Dict = object;

/** Drops `undefined` values so partial updates never overwrite a column with NULL. */
export function clean(data: Dict): Record<string, SqlValue> {
  const output: Record<string, SqlValue> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (value === undefined) continue;
    output[key] = toSqlValue(value);
  }
  return output;
}

function toSqlValue(value: unknown): SqlValue {
  if (value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return value;
  return JSON.stringify(value);
}

export async function insertRow<T = unknown>(table: string, data: Dict, db?: DbDriver): Promise<void> {
  const driver = db ?? (await getDb());
  const entries = Object.entries(clean(data));
  const columns = entries.map(([column]) => column).join(", ");
  const placeholders = entries.map(() => "?").join(", ");
  await driver.run(
    `INSERT INTO ${table} (${columns}) VALUES (${placeholders})`,
    entries.map(([, value]) => value),
  );
}

export async function updateRow<T = unknown>(
  table: string,
  id: string,
  data: Dict,
  db?: DbDriver,
): Promise<T | undefined> {
  const driver = db ?? (await getDb());
  const entries = Object.entries(clean(data));
  if (entries.length === 0) return findRowById<T>(table, id, driver);
  const assignments = entries.map(([column]) => `${column} = ?`).join(", ");
  await driver.run(`UPDATE ${table} SET ${assignments} WHERE id = ?`, [
    ...entries.map(([, value]) => value),
    id,
  ]);
  return findRowById<T>(table, id, driver);
}

export async function findRowById<T>(table: string, id: string, db?: DbDriver): Promise<T | undefined> {
  const driver = db ?? (await getDb());
  return driver.get<T>(`SELECT * FROM ${table} WHERE id = ?`, [id]);
}

export async function deleteRow(table: string, id: string, db?: DbDriver): Promise<number> {
  const driver = db ?? (await getDb());
  const result = await driver.run(`DELETE FROM ${table} WHERE id = ?`, [id]);
  return result.changes;
}

export async function countBy(
  table: string,
  where = "1 = 1",
  params: SqlValue[] = [],
  db?: DbDriver,
): Promise<number> {
  const driver = db ?? (await getDb());
  const row = await driver.get<{ total: number }>(
    `SELECT COUNT(*) AS total FROM ${table} WHERE ${where}`,
    params,
  );
  return Number(row?.total ?? 0);
}

/** Parses a JSON text column, returning `fallback` when empty or invalid. */
export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function stringifyJson(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

/** Escapes `%` and `_` for LIKE searches. */
export function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

/**
 * Column-name whitelist guard for dynamic ORDER BY clauses. Rejects anything
 * that is not a known column of the table, preventing SQL injection through
 * sort parameters.
 */
export function safeSort(columns: string[], requested: string | null | undefined, fallback: string): string {
  if (!requested) return fallback;
  const [field, direction] = requested.split(":");
  if (!field || !columns.includes(field)) return fallback;
  const dir = direction?.toLowerCase() === "asc" ? "ASC" : "DESC";
  return `${field} ${dir}`;
}
