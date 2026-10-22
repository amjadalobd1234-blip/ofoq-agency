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

describe("migration bookkeeping", () => {
  it("refuses an edited migration but accepts a renumbered one", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { runMigrations } = await import("../src/lib/db/migrate");
    const { getDb, setDbForTesting } = await import("../src/lib/db");

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ofoq-migrations-"));
    const dir = path.join(root, "db", "migrations", "sqlite");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "0001_first.sql"), "CREATE TABLE IF NOT EXISTS first (id TEXT PRIMARY KEY);\n");
    fs.writeFileSync(path.join(dir, "0002_second.sql"), "CREATE TABLE IF NOT EXISTS second (id TEXT PRIMARY KEY);\n");

    const db = await getDb();
    setDbForTesting(db);
    try {
      const first = await runMigrations(db, { rootDir: root });
      expect(first.applied).toEqual(["0001_first.sql", "0002_second.sql"]);

      // The same file, edited in place: refused.
      fs.writeFileSync(path.join(dir, "0002_second.sql"), "CREATE TABLE IF NOT EXISTS second (id TEXT PRIMARY KEY, extra TEXT);\n");
      await expect(runMigrations(db, { rootDir: root })).rejects.toThrow(/immutable/i);

      // A different file under an id that is already taken (a renumbered
      // generator output): the new file takes the id over.
      fs.writeFileSync(path.join(dir, "0002_second.sql"), "CREATE TABLE IF NOT EXISTS second (id TEXT PRIMARY KEY);\n");
      fs.writeFileSync(path.join(dir, "0002_other.sql"), "CREATE TABLE IF NOT EXISTS other (id TEXT PRIMARY KEY);\n");
      const renamed = await runMigrations(db, { rootDir: root });
      expect(renamed.applied).toContain("0002_other.sql");
      const rows = await db.query<{ id: string; name: string }>("SELECT id, name FROM _migrations ORDER BY id");
      expect(rows.find((row) => row.id === "0002")?.name).toBe("other");
    } finally {
      setDbForTesting(null);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
