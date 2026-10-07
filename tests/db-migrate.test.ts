import { describe, expect, it } from "vitest";

import { listMigrations, splitStatements, translate } from "../src/lib/db/migrate";

describe("migration runner utilities", () => {
  it("splits statements on semicolons outside string literals", () => {
    const sql = `
      CREATE TABLE t (a TEXT);
      INSERT INTO t VALUES ('a;b');
      -- comment; with semicolon
      INSERT INTO t VALUES ('x');
    `;
    const statements = splitStatements(sql);
    expect(statements).toHaveLength(3);
    expect(statements[1]).toContain("'a;b'");
  });

  it("keeps escaped quotes inside literals", () => {
    const statements = splitStatements("INSERT INTO t VALUES ('it''s; fine');");
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("it''s; fine");
  });

  it("does not rewrite type keywords inside string literals", () => {
    const sql = "INSERT INTO settings VALUES ('note', 'REAL value of INTEGER');";
    const translated = translate(sql, "postgres");
    expect(translated).toContain("'REAL value of INTEGER'");
  });

  it("rewrites portable types for postgres", () => {
    const translated = translate("CREATE TABLE t (a INTEGER NOT NULL, b REAL);", "postgres");
    expect(translated).toContain("BIGINT");
    expect(translated).toContain("DOUBLE PRECISION");
  });

  it("ships sequential, immutable migration files", () => {
    const migrations = listMigrations("db/migrations/sqlite");
    expect(migrations.length).toBeGreaterThanOrEqual(2);
    const ids = migrations.map((migration) => migration.id);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
    for (const migration of migrations) {
      expect(migration.checksum).toMatch(/^[a-f0-9]{64}$/);
    }
  });
});
