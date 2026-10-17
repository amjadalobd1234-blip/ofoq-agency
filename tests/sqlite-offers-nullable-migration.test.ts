import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SqliteDriver } from "../src/lib/db/sqlite";
import { listMigrations, runMigrations } from "../src/lib/db/migrate";

const sqliteMigrationsDir = path.join(process.cwd(), "db", "migrations", "sqlite");
const migrations = listMigrations(sqliteMigrationsDir);

/** Prove the new forward migration upgrades populated SQLite without losing child rows. */
describe("SQLite offers nullable-price migration", () => {
  let db: SqliteDriver | null = null;
  let tempRoot: string | null = null;

  afterEach(async () => {
    await db?.close();
    db = null;
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  });

  it("preserves existing offers/items and permits NULL only for the optional amounts", async () => {
    db = new SqliteDriver({ filename: ":memory:", wal: false });
    // Start from the immutable pre-change schema, with a populated offer and a
    // dependent item. The migration is run separately as a genuine upgrade.
    for (const migration of migrations.filter((item) => item.id === "0001" || item.id === "0002")) {
      await db.exec(migration.sql);
    }
    await db.exec(`
      INSERT INTO users (id, email, name, role, status, locale, created_at, updated_at)
      VALUES ('user-1', 'client@example.test', 'Client', 'CLIENT', 'ACTIVE', 'ar', '2026-01-01', '2026-01-01');
      INSERT INTO customers (id, user_id, contact_name, email, status, created_at, updated_at)
      VALUES ('customer-1', 'user-1', 'Client', 'client@example.test', 'ACTIVE', '2026-01-01', '2026-01-01');
      INSERT INTO offers (id, code, customer_id, status, currency, subtotal_minor, total_minor, internal_note, created_at, updated_at)
      VALUES ('offer-old', 'OFOQ-2026-001', 'customer-1', 'DRAFT', 'USD', 2500, 2500, 'preserve me', '2026-01-01', '2026-01-01');
      INSERT INTO offer_items (id, offer_id, description_ar, billing_type)
      VALUES ('item-old', 'offer-old', 'Existing line', 'ONE_TIME');
    `);

    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ofoq-nullable-offer-migration-"));
    const tempMigrationsDir = path.join(tempRoot, "db", "migrations", "sqlite");
    fs.mkdirSync(tempMigrationsDir, { recursive: true });
    const migration = migrations.find((item) => item.id === "0003");
    expect(migration).toBeDefined();
    fs.copyFileSync(path.join(sqliteMigrationsDir, migration!.filename), path.join(tempMigrationsDir, migration!.filename));

    await runMigrations(db, { rootDir: tempRoot });

    const oldOffer = await db.get<{ id: string; code: string; total_minor: number; subtotal_minor: number; internal_note: string }>(
      "SELECT id, code, total_minor, subtotal_minor, internal_note FROM offers WHERE id = ?",
      ["offer-old"],
    );
    expect(oldOffer).toEqual({
      id: "offer-old",
      code: "OFOQ-2026-001",
      total_minor: 2500,
      subtotal_minor: 2500,
      internal_note: "preserve me",
    });
    expect(await db.get<{ count: number }>("SELECT count(*) AS count FROM offer_items WHERE id = 'item-old'"))
      .toEqual({ count: 1 });

    const columns = await db.query<{ name: string; notnull: number }>("PRAGMA table_info(offers)");
    expect(columns.find((column) => column.name === "subtotal_minor")?.notnull).toBe(0);
    expect(columns.find((column) => column.name === "total_minor")?.notnull).toBe(0);
    await db.run(
      `INSERT INTO offers (id, code, customer_id, status, currency, subtotal_minor, total_minor, created_at, updated_at)
       VALUES (?, ?, ?, 'DRAFT', 'USD', NULL, NULL, ?, ?)`,
      ["offer-unpriced", "OFOQ-2026-002", "customer-1", "2026-10-17", "2026-10-17"],
    );
    expect(await db.get<{ subtotal_minor: number | null; total_minor: number | null }>(
      "SELECT subtotal_minor, total_minor FROM offers WHERE id = 'offer-unpriced'",
    )).toEqual({ subtotal_minor: null, total_minor: null });
    expect(await db.query("PRAGMA foreign_key_check")).toEqual([]);
  });
});
