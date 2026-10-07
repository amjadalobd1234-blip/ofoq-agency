#!/usr/bin/env tsx
/**
 * Database migrate CLI.
 *
 * Usage:
 *   npm run db:migrate            # apply pending migrations
 *   npm run db:status             # list applied / pending / drifted migrations
 */
import { closeDb, getDb } from "../src/lib/db";
import { migrationStatus, runMigrations } from "../src/lib/db/migrate";
import { configWarnings, getEnv } from "../src/lib/config/env";

async function main(): Promise<void> {
  const wantsStatus = process.argv.includes("--status");
  const env = getEnv();
  const db = await getDb();

  console.log(`\nأفق | Ofoq — database ${wantsStatus ? "status" : "migration"}`);
  console.log(`  driver : ${db.dialect}`);
  console.log(`  target : ${db.target}\n`);

  if (wantsStatus) {
    const status = await migrationStatus(db);
    console.log(`  applied : ${status.applied.length}`);
    for (const row of status.applied) {
      console.log(`    ✔ ${row.id} ${row.name} (${row.applied_at})`);
    }
    console.log(`  pending : ${status.pending.length}`);
    for (const file of status.pending) {
      console.log(`    · ${file.filename}`);
    }
    if (status.drift.length > 0) {
      console.log(`  ⚠ modified after apply: ${status.drift.join(", ")}`);
    }
    const warnings = configWarnings(env);
    if (warnings.length > 0) {
      console.log("\n  configuration warnings:");
      for (const warning of warnings) console.log(`    · ${warning}`);
    }
    console.log("");
    await closeDb();
    process.exit(status.drift.length > 0 ? 1 : 0);
  }

  const report = await runMigrations(db, { log: (message) => console.log(message) });
  console.log(
    `\n  ${report.applied.length} applied, ${report.skipped.length} already up to date (${report.durationMs}ms)\n`,
  );

  const warnings = configWarnings(env);
  if (warnings.length > 0) {
    console.log("  configuration warnings:");
    for (const warning of warnings) console.log(`    · ${warning}`);
    console.log("");
  }

  await closeDb();
}

main().catch(async (error) => {
  console.error("\n  ✖ migration failed:", error instanceof Error ? error.message : error);
  await closeDb().catch(() => {});
  process.exit(1);
});
