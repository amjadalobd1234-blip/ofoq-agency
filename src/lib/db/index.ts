import { getEnv, isBundleLocalPath, sqliteFilePath, type AppEnv } from "@/lib/config/env";
import { ConfigurationError } from "@/lib/core/errors";

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

/**
 * Where the platform database lives for this deployment.
 *
 * The rule is deliberate: the API never falls back to a local store when the
 * deployment asked for PostgreSQL, and a local store that cannot be opened in
 * production is reported as a configuration problem instead of an opaque
 * database error. A silent fallback would let the team read and write an
 * empty, isolated database while believing they work on the real one.
 */
export type DatabaseTarget =
  | { kind: "postgres"; url: string; label: string }
  | { kind: "sqlite"; file: string; label: string };

export function resolveDatabaseTarget(env: AppEnv = getEnv()): DatabaseTarget {
  if (env.database.driver === "postgres") {
    if (!env.database.url) {
      throw new ConfigurationError(
        "DATABASE_DRIVER=postgres requires DATABASE_URL (see .env.example and docs/DEPLOY-AR.md). " +
          "The local store is not used as a fallback: writing to the wrong database is worse than failing.",
      );
    }
    return { kind: "postgres", url: env.database.url, label: "postgres" };
  }
  const file = sqliteFilePath(env);
  return { kind: "sqlite", file, label: file };
}

async function createDriver(): Promise<DbDriver> {
  const env = getEnv();
  const target = resolveDatabaseTarget(env);
  if (target.kind === "postgres") {
    return PostgresDriver.create(target.url);
  }
  try {
    const driver = new SqliteDriver({ filename: target.file });
    if (env.isProduction && isBundleLocalPath(target.file)) {
      // The file opens, but on a serverless deployment the bundle disk is
      // ephemeral: the data would not survive a redeploy and would not be the
      // platform database. Say it in the logs.
      // eslint-disable-next-line no-console
      console.warn(
        "[db] the local SQLite store is inside the deployment bundle: it is not the platform database and it is not persistent on a serverless deployment. Set DATABASE_URL (see docs/DEPLOY-AR.md).",
      );
    }
    return driver;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (!env.isProduction) throw error;
    // The local store is not usable in this deployment (read-only bundle, no
    // volume, …). Say it plainly instead of returning a 500, and keep the
    // technical detail in the server log rather than in the answer.
    // eslint-disable-next-line no-console
    console.error(`[db] the local SQLite store is not usable in this deployment: ${reason}`);
    throw new ConfigurationError(
      "The platform database is not available in this deployment: the local SQLite store could not be opened. " +
        "Set DATABASE_URL (with DATABASE_DRIVER=postgres) to the same PostgreSQL database as the portal, " +
        "or point SQLITE_PATH at a persistent volume. See docs/DEPLOY-AR.md.",
      { file: target.file, reason },
    );
  }
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
