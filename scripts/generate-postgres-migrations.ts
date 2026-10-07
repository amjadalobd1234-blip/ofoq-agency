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
  const sources = listMigrations(sourceDir);
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
  generated.push(makeMigration("0003", "enable rls", "0003_enable_rls.sql", rlsSql));

  return generated;
}

/** Build the standalone, re-runnable schema script for Supabase SQL Editor. */
export function renderSupabaseSetupSql(migrations: GeneratedMigration[]): string {
  const setupStatements: string[] = [
    [
      "-- Ofoq / Supabase PostgreSQL setup",
      "-- Generated from db/migrations/sqlite/*.sql. Do not edit by hand.",
      "-- Regenerate with: npm run db:generate-postgres",
      "-- Creates 35 application tables plus the _migrations tracking table (36 total).",
      "-- Safe to re-run: existing tables and indexes are left unchanged.",
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
  fs.writeFileSync(setupPath, renderSupabaseSetupSql(migrations), "utf8");

  return migrations;
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
