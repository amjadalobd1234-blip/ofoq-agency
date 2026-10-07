import { getEnv, sqliteFilePath } from "@/lib/config/env";

import { PostgresDriver } from "./postgres";
import { SqliteDriver } from "./sqlite";
import type { DbDriver } from "./types";

/**
 * Connection manager.
 *
 * One driver instance is shared per process and cached on `globalThis` so that
 * Next.js hot-reloads in development (and route handler re-evaluations) do not
 * open a new SQLite handle on every edit.
 */
const globalForDb = globalThis as unknown as {
  __ofoqDb?: Promise<DbDriver>;
  __ofoqTestDb?: DbDriver;
};

export async function getDb(): Promise<DbDriver> {
  if (globalForDb.__ofoqTestDb) return globalForDb.__ofoqTestDb;
  if (!globalForDb.__ofoqDb) {
    globalForDb.__ofoqDb = createDriver().catch((error) => {
      // Allow a retry on the next call instead of caching a rejected promise.
      globalForDb.__ofoqDb = undefined;
      throw error;
    });
  }
  return globalForDb.__ofoqDb;
}

async function createDriver(): Promise<DbDriver> {
  const env = getEnv();
  if (env.database.driver === "postgres") {
    if (!env.database.url) {
      throw new Error(
        "DATABASE_DRIVER=postgres requires DATABASE_URL (see .env.example). Falling back is not automatic to avoid writing to the wrong store.",
      );
    }
    return PostgresDriver.create(env.database.url);
  }
  return new SqliteDriver({ filename: sqliteFilePath(env) });
}

/** Used by tests and CLI scripts to inject an isolated database. */
export function setDbForTesting(driver: DbDriver | null): void {
  globalForDb.__ofoqTestDb = driver ?? undefined;
  if (driver) globalForDb.__ofoqDb = undefined;
}

/** Runs `fn` in a transaction (joins an outer transaction when nested). */
export async function withTransaction<T>(fn: (tx: DbDriver) => Promise<T>): Promise<T> {
  const db = await getDb();
  return db.transaction(fn);
}

export async function closeDb(): Promise<void> {
  const pending = globalForDb.__ofoqDb;
  globalForDb.__ofoqDb = undefined;
  if (pending) {
    const driver = await pending.catch(() => null);
    await driver?.close();
  }
}

export interface DbHealth {
  ok: boolean;
  dialect: string;
  target: string;
  latencyMs: number;
  error?: string;
}

export async function checkDbHealth(): Promise<DbHealth> {
  const started = Date.now();
  try {
    const db = await getDb();
    await db.get("SELECT 1 AS ok");
    return { ok: true, dialect: db.dialect, target: db.target, latencyMs: Date.now() - started };
  } catch (error) {
    return {
      ok: false,
      dialect: getEnv().database.driver,
      target: getEnv().database.sqlitePath,
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
