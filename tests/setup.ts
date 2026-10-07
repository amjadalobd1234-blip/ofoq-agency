/**
 * Vitest global setup.
 *
 * Every test file gets a private in-memory SQLite database with the real
 * migrations applied and the baseline seed data loaded, so tests exercise the
 * same schema and the same starting catalogue that production uses.
 */
import { beforeAll, afterAll } from "vitest";

import { SqliteDriver } from "../src/lib/db/sqlite";
import { runMigrations } from "../src/lib/db/migrate";
import { setDbForTesting } from "../src/lib/db";
import { loadEnvFiles } from "../src/lib/config/load-env";
import { seedBaselineData } from "../src/lib/services/seed-data";

loadEnvFiles();

let driver: SqliteDriver | null = null;

beforeAll(async () => {
  driver = new SqliteDriver({ filename: ":memory:" });
  // The transaction mutex makes it safe to share one connection per file.
  await runMigrations(driver, { rootDir: process.cwd() });
  setDbForTesting(driver);
  // Same starting point as `npm run db:seed`: the service catalogue, the agent
  // registry and the default settings. No demo records.
  await seedBaselineData();
});

afterAll(async () => {
  setDbForTesting(null);
  await driver?.close();
});

/** Exposes the raw driver to tests that need extra DDL. */
export function testDriver(): SqliteDriver {
  if (!driver) throw new Error("Test database is not initialised");
  return driver;
}
