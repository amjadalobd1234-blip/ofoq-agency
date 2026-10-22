#!/usr/bin/env tsx
/**
 * Generate the PostgreSQL dialect migrations and a one-shot Supabase SQL setup
 * from the SQLite migrations, which are the canonical application schema.
 *
 * Usage: npm run db:generate-postgres
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { listMigrations, splitStatements, translate } from "../src/lib/db/migrate";

export interface GeneratedMigration {
  id: string;
  name: string;
  filename: string;
  sql: string;
  checksum: string;
}

const GENERATED_HEADER = [
  "-- GENERATED FILE — do not edit by hand.",
  "-- Source of truth: db/migrations/sqlite/*.sql",
  "-- Regenerate with: npm run db:generate-postgres",
].join("\n");

const MIGRATIONS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS public._migrations (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  checksum     TEXT NOT NULL,
  applied_at   TEXT NOT NULL,
  duration_ms  BIGINT NOT NULL DEFAULT 0
);`;

/** Build all PostgreSQL migration contents without writing to disk. */
export function renderPostgresMigrations(rootDir = process.cwd()): GeneratedMigration[] {
  const sourceDir = path.join(rootDir, "db", "migrations", "sqlite");
  const allSources = listMigrations(sourceDir);
  // A dialect-specific table rebuild can carry an explicit PostgreSQL
  // equivalent instead of translating SQLite PRAGMAs or silently omitting it.
  const sources = allSources.filter((source) => !source.sql.includes("-- @postgres-skip:"));
  if (sources.length === 0) {
    throw new Error(`No SQLite migrations found in ${sourceDir}`);
  }

  const knownTables = new Set<string>();
  const generated = sources.map((source) => {
    const statements = splitStatements(translate(source.sql, "postgres"));
    const ordered = orderStatements(source.filename, statements, knownTables);
    const sql = `${GENERATED_HEADER}\n-- Generated from ${source.filename}.\n\n${formatStatements(ordered)}`;
    return makeMigration(source.id, source.name, source.filename, sql);
  });

  const allApplicationTables = [...knownTables].sort();
  if (allApplicationTables.length === 0) {
    throw new Error("The source migrations did not declare any tables");
  }

  // Supabase exposes the public schema through its Data API. Enabling RLS with
  // no anon/authenticated policies keeps these tables private; the Ofoq server
  // connects with its server-only database URL as the table owner.
  const rlsStatements = ["_migrations", ...allApplicationTables].map(
    (table) => `ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;`,
  );
  const rlsSql = `${GENERATED_HEADER}\n-- Defense in depth for Supabase's exposed public schema.\n-- No client-facing policies are created; use the server-only DATABASE_URL.\n\n${formatStatements(rlsStatements)}`;
  // RLS is enabled on every table, so it must run AFTER the table migrations:
  // `ALTER TABLE … ENABLE ROW LEVEL SECURITY` fails when the table is missing.
  // The migration therefore takes the next free id instead of a fixed one.
  const rlsId = String(Math.max(...generated.map((migration) => Number(migration.id))) + 1).padStart(4, "0");
  generated.push(makeMigration(rlsId, "enable rls", `${rlsId}_enable_rls.sql`, rlsSql));

  let nextDialectMigrationId = Number(rlsId) + 1;
  for (const source of allSources.filter((candidate) => candidate.sql.includes("-- @postgres-skip:"))) {
    const equivalentStatements = [...source.sql.matchAll(/^-- @postgres-equivalent:\s*(.+)$/gm)].map((match) => match[1]!.trim());
    if (equivalentStatements.length === 0) continue;
    const nameMatch = /^-- @postgres-name:\s*(.+)$/m.exec(source.sql);
    if (!nameMatch) throw new Error(`${source.filename} declares PostgreSQL SQL without -- @postgres-name`);
    const id = String(nextDialectMigrationId++).padStart(4, "0");
    const name = nameMatch[1]!.trim();
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    const filename = `${id}_${slug}.sql`;
    const sql = [
      GENERATED_HEADER,
      `-- PostgreSQL equivalent of ${source.filename}.`,
      "",
      formatStatements(equivalentStatements.flatMap((statement) => splitStatements(statement))),
    ].join(String.fromCharCode(10));
    generated.push(makeMigration(id, name, filename, sql));
  }

  return generated;
}

/** Build the standalone, re-runnable schema script for Supabase SQL Editor. */
export function renderSupabaseSetupSql(migrations: GeneratedMigration[], rootDir = process.cwd()): string {
  const setupStatements: string[] = [
    [
      "-- Ofoq / Supabase PostgreSQL setup",
      "-- Generated from db/migrations/sqlite/*.sql. Do not edit by hand.",
      "-- Regenerate with: npm run db:generate-postgres",
      "-- Creates 35 application tables plus _migrations, ai_usage, and the",
      "-- private service-request price-verification table (38 tables in total).",
      "-- Safe to re-run: existing tables and indexes are left unchanged.",
      "-- The bundle also installs Supabase Auth triggers, RLS-safe REST RPCs, and column grants.",
      "-- Run this as the Supabase database owner (normally `postgres`).",
    ].join("\n"),
    "CREATE SCHEMA IF NOT EXISTS public;",
    "SET search_path TO public;",
    MIGRATIONS_TABLE_SQL,
  ];

  for (const migration of migrations) {
    for (const statement of splitStatements(migration.sql)) {
      if (/^\s*CREATE\s+TABLE\b/i.test(statement) && /\b_migrations\b/i.test(statement)) {
        continue;
      }
      setupStatements.push(makeIdempotentForSetup(statement));
    }
  }

  // Supabase-specific Auth triggers, REST/RLS policies, safe RPCs and the AI
  // usage log are kept separate from the portable SQLite source migrations.
  // Include every file in db/migrations/supabase (filename order) in the manual
  // SQL Editor bundle, without ever opening a database connection here.
  const supabaseDir = path.join(rootDir, "db", "migrations", "supabase");
  if (fs.existsSync(supabaseDir)) {
    const supabaseFiles = fs
      .readdirSync(supabaseDir)
      .filter((file) => file.endsWith(".sql"))
      .sort();
    for (const file of supabaseFiles) {
      setupStatements.push(
        [
          `-- Supabase Auth, portal RPCs, RLS/column privileges and platform logs.`,
          `-- Source: db/migrations/supabase/${file}.`,
          fs.readFileSync(path.join(supabaseDir, file), "utf8").trim(),
        ].join("\n"),
      );
    }
  }

  const appliedRows = migrations
    .map((migration) => {
      const escapedName = migration.name.replace(/'/g, "''");
      return `  ('${migration.id}', '${escapedName}', '${migration.checksum}', CURRENT_TIMESTAMP::text, 0)`;
    })
    .join(",\n");
  setupStatements.push(
    [
      "-- Mark the generated migrations as applied so `npm run db:migrate` is safe",
      "-- after this manual SQL setup. Checksums are computed from the generated files.",
      "INSERT INTO public._migrations (id, name, checksum, applied_at, duration_ms)",
      "VALUES",
      appliedRows,
      "ON CONFLICT (id) DO NOTHING;",
    ].join("\n"),
  );

  return `${setupStatements.join("\n\n").trim()}\n`;
}

/** Generate PostgreSQL migrations and Supabase SQL on disk. */
export function generatePostgresMigrations(rootDir = process.cwd()): GeneratedMigration[] {
  const migrations = renderPostgresMigrations(rootDir);
  const outputDir = path.join(rootDir, "db", "migrations", "postgres");
  const setupPath = path.join(rootDir, "docs", "setup", "supabase-setup.sql");

  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(path.dirname(setupPath), { recursive: true });

  for (const migration of migrations) {
    fs.writeFileSync(path.join(outputDir, migration.filename), migration.sql, "utf8");
  }
  removeSupersededMigrations(outputDir, migrations);
  fs.writeFileSync(setupPath, renderSupabaseSetupSql(migrations, rootDir), "utf8");

  return migrations;
}

/**
 * Deletes the generated files that the current source no longer produces.
 *
 * The PostgreSQL directory holds generated files only, so a file that is not
 * part of the new set is a leftover of an earlier generation (a renamed or
 * renumbered migration). Leaving it on disk would apply a stale migration —
 * for example the old `0003_enable_rls.sql` that enables RLS before the tables
 * exist. Only files carrying the generated header are removed.
 */
function removeSupersededMigrations(outputDir: string, migrations: GeneratedMigration[]): void {
  const keep = new Set(migrations.map((migration) => migration.filename));
  if (!fs.existsSync(outputDir)) return;
  for (const file of fs.readdirSync(outputDir)) {
    if (!file.endsWith(".sql") || keep.has(file)) continue;
    const fullPath = path.join(outputDir, file);
    const content = fs.readFileSync(fullPath, "utf8");
    if (!content.startsWith("-- GENERATED FILE")) continue;
    fs.rmSync(fullPath);
  }
}

function makeMigration(id: string, name: string, filename: string, sql: string): GeneratedMigration {
  return {
    id,
    name,
    filename,
    sql,
    checksum: crypto.createHash("sha256").update(sql).digest("hex"),
  };
}

/**
 * PostgreSQL requires referenced tables to exist when a foreign key is added.
 * SQLite permits a forward reference, so order CREATE TABLE statements by
 * their REFERENCES dependencies before emitting indexes and other statements.
 */
function orderStatements(
  filename: string,
  statements: string[],
  knownTables: Set<string>,
): string[] {
  const tableStatements: Array<{ table: string; sql: string }> = [];
  const otherStatements: string[] = [];

  for (const sql of statements) {
    const match = /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w"]+)\s*\(/i.exec(sql);
    if (!match) {
      otherStatements.push(sql);
      continue;
    }
    const table = unquoteIdentifier(match[1]);
    if (knownTables.has(table)) {
      throw new Error(`${filename} creates table ${table} more than once`);
    }
    tableStatements.push({ table, sql });
  }

  const pending = [...tableStatements];
  const pendingNames = new Set(pending.map(({ table }) => table));
  const ordered: string[] = [];

  while (pending.length > 0) {
    const readyIndex = pending.findIndex(({ table, sql }) => {
      const refs = referencedTables(sql);
      for (const ref of refs) {
        if (ref === table || knownTables.has(ref)) continue;
        if (!pendingNames.has(ref)) {
          throw new Error(`${filename}: table ${table} references missing table ${ref}`);
        }
        return false;
      }
      return true;
    });

    if (readyIndex < 0) {
      const cycle = pending.map(({ table }) => table).join(", ");
      throw new Error(`${filename}: cyclic or unresolved table references: ${cycle}`);
    }

    const [ready] = pending.splice(readyIndex, 1);
    pendingNames.delete(ready.table);
    ordered.push(ready.sql);
    knownTables.add(ready.table);
  }

  return [...ordered, ...otherStatements];
}

function referencedTables(sql: string): string[] {
  const refs: string[] = [];
  const pattern = /\bREFERENCES\s+([\w".]+)\s*\(/gi;
  for (const match of sql.matchAll(pattern)) {
    const raw = match[1].split(".").at(-1) ?? match[1];
    refs.push(unquoteIdentifier(raw));
  }
  return refs;
}

function unquoteIdentifier(identifier: string): string {
  return identifier.replace(/^"|"$/g, "").toLowerCase();
}

function formatStatements(statements: string[]): string {
  return `${statements.map((statement) => `${statement.trim().replace(/;+$/, "")};`).join("\n\n")}\n`;
}

function makeIdempotentForSetup(statement: string): string {
  let sql = statement.trim();
  sql = sql.replace(/^CREATE\s+TABLE\s+/i, "CREATE TABLE IF NOT EXISTS public.");
  sql = sql.replace(/^CREATE\s+INDEX\s+/i, "CREATE INDEX IF NOT EXISTS ");
  sql = sql.replace(/^CREATE\s+UNIQUE\s+INDEX\s+/i, "CREATE UNIQUE INDEX IF NOT EXISTS ");
  sql = sql.replace(/^ALTER\s+TABLE\s+(?!public\.)/i, "ALTER TABLE public.");
  // Re-running the setup script must not fail on a column that already exists.
  sql = sql.replace(/\bADD\s+COLUMN\s+(?!IF\s+NOT\s+EXISTS)/gi, "ADD COLUMN IF NOT EXISTS ");
  return `${sql.replace(/;+$/, "")};`;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return Boolean(entry && path.resolve(entry) === fileURLToPath(import.meta.url));
}

if (isMainModule()) {
  try {
    const migrations = generatePostgresMigrations();
    console.log(`Generated ${migrations.length} PostgreSQL migrations:`);
    for (const migration of migrations) {
      console.log(`  ${migration.filename} (${migration.checksum})`);
    }
    console.log("Generated docs/setup/supabase-setup.sql");
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
