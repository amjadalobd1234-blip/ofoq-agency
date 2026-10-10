import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  renderPostgresMigrations,
  renderSupabaseSetupSql,
} from "../scripts/generate-postgres-migrations";
import { listMigrations, splitStatements } from "../src/lib/db/migrate";
import { parsePostgresInt8 } from "../src/lib/db/postgres";

const rootDir = process.cwd();
const postgresDir = path.join(rootDir, "db", "migrations", "postgres");
const setupPath = path.join(rootDir, "docs", "setup", "supabase-setup.sql");

function tableName(statement: string): string | undefined {
  const match = /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?([\w"]+)/i.exec(statement);
  return match?.[1].replace(/^"|"$/g, "").toLowerCase();
}

function references(statement: string): string[] {
  return [...statement.matchAll(/\bREFERENCES\s+(?:public\.)?([\w"]+)\s*\(/gi)].map(
    (match) => match[1].replace(/^"|"$/g, "").toLowerCase(),
  );
}

describe("PostgreSQL schema artifacts", () => {
  it("keeps generated migrations and Supabase setup SQL in sync", () => {
    const expected = renderPostgresMigrations(rootDir);
    const actual = listMigrations(postgresDir);
    const setupSql = fs.readFileSync(setupPath, "utf8");

    expect(actual.map(({ filename, sql }) => ({ filename, sql }))).toEqual(
      expected.map(({ filename, sql }) => ({ filename, sql })),
    );
    expect(setupSql).toBe(renderSupabaseSetupSql(expected));
  });

  it("contains the 35 application tables and 37 total setup tables", () => {
    const sourceTables = listMigrations(path.join(rootDir, "db", "migrations", "sqlite"))
      .flatMap((migration) => splitStatements(migration.sql))
      .map(tableName)
      .filter((name): name is string => Boolean(name));
    const generated = listMigrations(postgresDir);
    const postgresTables = generated
      .flatMap((migration) => splitStatements(migration.sql))
      .map(tableName)
      .filter((name): name is string => Boolean(name));
    const setupTables = splitStatements(fs.readFileSync(setupPath, "utf8"))
      .map(tableName)
      .filter((name): name is string => Boolean(name));

    expect(new Set(sourceTables).size).toBe(35);
    expect(new Set(postgresTables).size).toBe(35);
    // 35 application tables + _migrations + the Supabase-only ai_usage log.
    expect(new Set(setupTables).size).toBe(37);
    expect(new Set(setupTables)).toContain("_migrations");
    expect(new Set(setupTables)).toContain("users");
    expect(new Set(setupTables)).toContain("job_runs");
    expect(new Set(setupTables)).toContain("ai_usage");
  });

  it("orders foreign-key dependencies before dependent PostgreSQL tables", () => {
    const migrations = listMigrations(postgresDir);
    const knownTables = new Set<string>();

    for (const migration of migrations) {
      for (const statement of splitStatements(migration.sql)) {
        const table = tableName(statement);
        if (!table) continue;
        for (const referenced of references(statement)) {
          expect(
            referenced === table || knownTables.has(referenced),
            `${migration.filename}: ${table} references ${referenced} before it is created`,
          ).toBe(true);
        }
        knownTables.add(table);
      }
    }

    const firstMigrationTables = splitStatements(migrations[0].sql)
      .map(tableName)
      .filter((name): name is string => Boolean(name));
    expect(firstMigrationTables.indexOf("subscriptions")).toBeLessThan(
      firstMigrationTables.indexOf("payments"),
    );
  });

  it("normalises PostgreSQL BIGINT values without silently losing precision", () => {
    expect(parsePostgresInt8("42")).toBe(42);
    expect(parsePostgresInt8("9007199254740992")).toBe("9007199254740992");
  });

  it("bundles Supabase Auth triggers, narrow RLS access and REST RPCs", () => {
    const setupSql = fs.readFileSync(setupPath, "utf8");
    const authSql = fs.readFileSync(path.join(rootDir, "db", "migrations", "supabase", "0001_auth_portal.sql"), "utf8");
    expect(setupSql).toContain(authSql.trim());
    expect(authSql).toContain("ofoq_auth_user_created");
    expect(authSql).toContain("ofoq_client_dashboard");
    expect(authSql).toContain("ofoq_client_chat_send");
    expect(authSql).toContain("ofoq_admin_dashboard");
    expect(authSql).toContain("REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM anon, authenticated");
    expect(authSql).toContain("REVOKE ALL ON FUNCTION public.ofoq_create_auth_profile() FROM PUBLIC, anon, authenticated");
    expect(authSql).toContain("id = (SELECT auth.uid())::text");
    expect(authSql).toContain("SECURITY DEFINER");
  });

  it("uses PostgreSQL numeric types and records the matching migration checksums", () => {
    const migrations = listMigrations(postgresDir);
    const setupSql = fs.readFileSync(setupPath, "utf8");

    for (const migration of migrations) {
      const statements = splitStatements(migration.sql);
      expect(statements.length).toBeGreaterThan(0);
      for (const statement of statements) {
        expect(statement).not.toMatch(/\b(?:INTEGER|REAL)\b/i);
      }
      expect(setupSql).toContain(`'${migration.id}', '${migration.name}', '${migration.checksum}'`);
    }

    expect(migrations.map(({ id }) => id)).toEqual(["0001", "0002", "0003"]);
    expect(migrations[2].sql).toContain("ENABLE ROW LEVEL SECURITY");
  });
});
