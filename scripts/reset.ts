#!/usr/bin/env tsx
/**
 * Reset CLI.
 *
 *   npm run db:reset              # drop everything, re-run migrations, re-seed baseline
 *   npm run db:reset -- --demo    # remove ONLY demo records (safe in any environment)
 *   npm run db:reset -- --empty   # drop everything and migrate, but do not seed
 *   npm run db:reset -- --yes     # skip the interactive confirmation
 *
 * Destructive operations refuse to run in production without --yes, so a typo on a
 * live server cannot wipe client data.
 */
import fs from "node:fs";
import readline from "node:readline/promises";

import { closeDb, getDb } from "../src/lib/db";
import { runMigrations } from "../src/lib/db/migrate";
import { configWarnings, getEnv, sqliteFilePath } from "../src/lib/config/env";

const args = new Set(process.argv.slice(2));

async function confirm(question: string): Promise<boolean> {
  if (args.has("--yes")) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function removeDemo(): Promise<void> {
  const { removeDemoData } = await import("../src/lib/services/seed-helpers");
  const summary = await removeDemoData();
  console.log(`  demo data: ${summary}`);
}

async function hardReset(): Promise<void> {
  const env = getEnv();
  const db = await getDb();
  console.log(`  target: ${db.dialect} @ ${db.target}`);

  // SQLite: the cleanest reset is deleting the database file(s).
  if (db.dialect === "sqlite") {
    await closeDb();
    const path = sqliteFilePath(env);
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      const file = `${path}${suffix}`;
      if (fs.existsSync(file)) fs.rmSync(file);
    }
    const fresh = await getDb();
    await runMigrations(fresh, { log: (message) => console.log(message) });
    return;
  }

  // PostgreSQL: delete all rows in dependency order (keeps the schema).
  const tables = [
    "campaign_metrics_daily",
    "campaign_changes",
    "campaigns",
    "reports",
    "payments",
    "invoices",
    "subscriptions",
    "offer_items",
    "offers",
    "project_tasks",
    "project_services",
    "projects",
    "messages",
    "conversations",
    "files",
    "reviews",
    "customer_facts",
    "customers",
    "notifications",
    "alerts",
    "outbox_emails",
    "webhook_events",
    "integration_connections",
    "job_runs",
    "agent_actions",
    "agent_runs",
    "agents",
    "activities",
    "verification_tokens",
    "sessions",
    "login_attempts",
    "rate_limits",
    "settings",
    "services",
    "users",
  ];
  for (const table of tables) {
    await db.exec(`DELETE FROM ${table}`);
  }
  console.log("  tables cleared");
}

async function main(): Promise<void> {
  const env = getEnv();
  console.log("\nأفق | Ofoq — database reset\n");

  if (args.has("--demo")) {
    await removeDemo();
    console.log("\n  done.\n");
    await closeDb();
    return;
  }

  if (env.isProduction && !args.has("--yes")) {
    console.error("  ✖ refusing to reset a production database without --yes");
    process.exit(1);
  }
  if (!env.isProduction) {
    const warnings = configWarnings(env);
    if (warnings.length > 0) {
      for (const warning of warnings) console.log(`  ⚠ ${warning}`);
    }
  }

  const ok = await confirm("This deletes ALL data in the configured database. Continue?");
  if (!ok) {
    console.log("  aborted.");
    await closeDb();
    return;
  }

  await hardReset();

  if (!args.has("--empty")) {
    await closeDb();
    // Re-seed through the documented CLI so behaviour stays identical.
    const { spawnSync } = await import("node:child_process");
    const result = spawnSync("npx", ["tsx", "scripts/seed.ts"], { stdio: "inherit" });
    if (result.status !== 0) process.exit(result.status ?? 1);
    return;
  }

  console.log("\n  done (empty database, migrations applied).\n");
  await closeDb();
}

main().catch(async (error) => {
  console.error("\n  ✖ reset failed:", error instanceof Error ? error.message : error);
  await closeDb().catch(() => {});
  process.exit(1);
});
