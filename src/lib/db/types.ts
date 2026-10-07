/**
 * Database driver contract.
 *
 * The whole application talks to storage exclusively through this interface, so
 * the SQLite driver (zero-setup default) and the PostgreSQL driver (scale-out)
 * are interchangeable without touching repositories, services or UI code.
 *
 * The API is deliberately async even though SQLite is synchronous: an async
 * contract is the only one both engines can honour without leaking their
 * differences into the rest of the platform.
 */

export type SqlDialect = "sqlite" | "postgres";

export type SqlValue = string | number | null | boolean | Uint8Array;

export type Row = Record<string, string | number | null | boolean | Uint8Array>;

export interface RunResult {
  /** Number of rows affected by the statement. */
  changes: number;
  /** Auto-increment id, when the engine provides one. */
  lastInsertRowid?: number;
}

export interface DbDriver {
  readonly dialect: SqlDialect;
  /** Human readable target, e.g. `./data/ofoq.sqlite`. Never contains secrets. */
  readonly target: string;

  query<T = Row>(sql: string, params?: SqlValue[]): Promise<T[]>;
  get<T = Row>(sql: string, params?: SqlValue[]): Promise<T | undefined>;
  run(sql: string, params?: SqlValue[]): Promise<RunResult>;

  /** Runs a statement batch without parameters (used by migrations). */
  exec(sql: string): Promise<void>;

  /**
   * Runs `fn` inside a transaction. Nested calls join the outer transaction.
   * Any thrown error rolls the whole transaction back.
   */
  transaction<T>(fn: (tx: DbDriver) => Promise<T>): Promise<T>;

  close(): Promise<void>;
}

/** Raised when a query fails; carries the statement for logging without values. */
export class DbError extends Error {
  readonly cause?: unknown;
  readonly sql: string;

  constructor(message: string, sql: string, cause?: unknown) {
    super(message);
    this.name = "DbError";
    this.sql = sql;
    this.cause = cause;
  }
}

/** Normalises driver-specific values into plain JSON-friendly primitives. */
export function normaliseValue(value: unknown): SqlValue {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "object") {
    // Buffers / typed arrays (e.g. Postgres bytea) become base64 text so callers
    // always receive a serialisable value.
    const maybeBuffer = value as { toString?: (encoding?: string) => string };
    if (typeof maybeBuffer.toString === "function") return maybeBuffer.toString("base64");
    return JSON.stringify(value);
  }
  return value as SqlValue;
}

export function normaliseRow<T = Row>(row: Record<string, unknown>): T {
  const output: Record<string, SqlValue> = {};
  for (const [key, value] of Object.entries(row)) {
    output[key] = normaliseValue(value);
  }
  return output as T;
}
