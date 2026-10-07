#!/usr/bin/env tsx
/**
 * Seed CLI.
 *
 *   npm run db:seed              # baseline data only (services, agents, settings)
 *   npm run db:seed -- --demo    # + clearly-labelled DEMO records (development only)
 *
 * Baseline seeding is idempotent and safe to run on every deploy: it never
 * duplicates rows and never touches client data or values the owner edited.
 *
 * DEMO DATA is written with `is_demo = 1` and can be removed again with
 * `npm run db:reset -- --demo`. It is never inserted with NODE_ENV=production.
 */
import { closeDb, getDb } from "../src/lib/db";
import { configWarnings, getEnv } from "../src/lib/config/env";
import { seedBaselineData } from "../src/lib/services/seed-data";
import { hashPassword } from "../src/lib/services/identity.service";
import { createUser, findUserByEmail } from "../src/lib/repositories/identity.repo";

const DEMO_FLAG = process.argv.includes("--demo");

async function seedStaffAccount(): Promise<void> {
  const email = process.env.SEED_OWNER_EMAIL?.trim().toLowerCase();
  if (!email) {
    console.log("  owner    : skipped (set SEED_OWNER_EMAIL and SEED_OWNER_PASSWORD to create one)");
    return;
  }
  const existing = await findUserByEmail(email);
  if (existing) {
    console.log(`  owner    : ${email} already exists`);
    return;
  }
  const password = process.env.SEED_OWNER_PASSWORD ?? generatePassword();
  await createUser({
    email,
    name: process.env.SEED_OWNER_NAME?.trim() || "Agency owner",
    role: "OWNER",
    locale: "ar",
    password_hash: await hashPassword(password),
    email_verified_at: new Date().toISOString(),
    status: "ACTIVE",
  });
  console.log(`  owner    : created ${email}`);
  if (!process.env.SEED_OWNER_PASSWORD) {
    console.log(`\n  ⚠ generated password (change it after signing in): ${password}\n`);
  }
}

function generatePassword(): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const { randomInt } = require("node:crypto") as typeof import("node:crypto");
  let output = "";
  for (let index = 0; index < 16; index += 1) {
    output += alphabet[randomInt(0, alphabet.length)];
  }
  return `${output}9`;
}

async function main(): Promise<void> {
  const env = getEnv();
  const db = await getDb();
  console.log(`\nأفق | Ofoq — seeding (${db.dialect} @ ${db.target})\n`);

  for (const warning of configWarnings(env)) console.log(`  ⚠ ${warning}`);

  const baseline = await seedBaselineData();
  console.log(
    `  services : ${baseline.servicesCreated} created, ${baseline.servicesTotal - baseline.servicesCreated} already present`,
  );
  console.log(`  agents   : ${baseline.agents} registered`);
  console.log(`  settings : ${baseline.settingsCreated} defaults ensured (existing values kept)`);

  await seedStaffAccount();

  if (DEMO_FLAG || env.seedDemoData) {
    if (env.isProduction) {
      console.log("\n  ✖ refusing to insert demo data with NODE_ENV=production.");
    } else {
      const { seedDemoData } = await import("../src/lib/services/seed-helpers");
      console.log(`  demo     : ${await seedDemoData()}`);
    }
  } else {
    console.log("  demo     : skipped (use --demo or SEED_DEMO_DATA=true to insert clearly-labelled demo records)");
  }

  console.log("\n  done.\n");
  await closeDb();
}

main().catch(async (error) => {
  console.error("\n  ✖ seed failed:", error instanceof Error ? error.message : error);
  await closeDb().catch(() => {});
  process.exit(1);
});
