import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { DbDriver, SqlDialect } from "./types";

/**
 * Forward-only migration runner.
 *
 * Migrations live in `db/migrations/<dialect>/NNNN_name.sql` and are applied in
 * filename order, each inside its own transaction. A SHA-256 checksum of every
 * applied file is stored in `_migrations`; editing an already-applied migration
 * is reported as an error instead of being silently ignored.
 *
 * SQLite migrations are the canonical schema. PostgreSQL-specific files are
 * generated from them by `npm run db:generate-postgres`; when a dialect-specific
 * directory is absent, the SQLite files are translated on the fly.
 */

export interface MigrationFile {
  id: string;
  name: string;
  filename: string;
  sql: string;
  checksum: string;
}

export interface MigrationStatusRow {
  id: string;
  name: string;
  checksum: string;
  applied_at: string;
  duration_ms: number;
}

export interface MigrationReport {
  applied: string[];
  skipped: string[];
  durationMs: number;
}

const MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS _migrations (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  checksum     TEXT NOT NULL,
  applied_at   TEXT NOT NULL,
  duration_ms  INTEGER NOT NULL DEFAULT 0
)`;

export function migrationsDir(rootDir: string, dialect: SqlDialect): string {
  const specific = path.join(rootDir, "db", "migrations", dialect);
  if (fs.existsSync(specific)) return specific;
  return path.join(rootDir, "db", "migrations", "sqlite");
}

export function listMigrations(dir: string): MigrationFile[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((filename) => {
      const sql = fs.readFileSync(path.join(dir, filename), "utf8");
      const match = /^(\d+)_(.+)\.sql$/.exec(filename);
      const id = match?.[1] ?? filename.replace(/\.sql$/, "");
      const name = (match?.[2] ?? filename).replace(/_/g, " ");
      return {
        id,
        name,
        filename,
        sql,
        checksum: crypto.createHash("sha256").update(sql).digest("hex"),
      };
    });
}

export async function runMigrations(
  db: DbDriver,
  options: { rootDir?: string; log?: (message: string) => void } = {},
): Promise<MigrationReport> {
  const rootDir = options.rootDir ?? process.cwd();
  const log = options.log ?? (() => {});
  const started = Date.now();
  const dir = migrationsDir(rootDir, db.dialect);

  await db.exec(translate(MIGRATIONS_TABLE, db.dialect));

  const applied = await db.query<MigrationStatusRow>("SELECT * FROM _migrations");
  const appliedById = new Map(applied.map((row) => [row.id, row]));
  const files = listMigrations(dir);

  const report: MigrationReport = { applied: [], skipped: [], durationMs: 0 };

  for (const file of files) {
    const existing = appliedById.get(file.id);
    if (existing) {
      if (existing.checksum !== file.checksum) {
        throw new Error(
          `Migration ${file.filename} was modified after it was applied (checksum mismatch). ` +
            `Migrations are immutable — create a new file instead of editing ${file.filename}.`,
        );
      }
      report.skipped.push(file.filename);
      continue;
    }

    const statements = splitStatements(translate(file.sql, db.dialect));
    const statementStarted = Date.now();
    await db.transaction(async (tx) => {
      for (const statement of statements) {
        await tx.exec(statement);
      }
      await tx.run(
        "INSERT INTO _migrations (id, name, checksum, applied_at, duration_ms) VALUES (?, ?, ?, ?, ?)",
        [file.id, file.name, file.checksum, new Date().toISOString(), 0],
      );
    });
    await db.run("UPDATE _migrations SET duration_ms = ? WHERE id = ?", [
      Date.now() - statementStarted,
      file.id,
    ]);

    log(`  ✔ ${file.filename}`);
    report.applied.push(file.filename);
  }

  report.durationMs = Date.now() - started;
  return report;
}

export async function migrationStatus(
  db: DbDriver,
  rootDir = process.cwd(),
): Promise<{ pending: MigrationFile[]; applied: MigrationStatusRow[]; drift: string[] }> {
  await db.exec(translate(MIGRATIONS_TABLE, db.dialect));
  const applied = await db.query<MigrationStatusRow>("SELECT * FROM _migrations ORDER BY id");
  const files = listMigrations(migrationsDir(rootDir, db.dialect));
  const appliedIds = new Set(applied.map((row) => row.id));
  const pending = files.filter((file) => !appliedIds.has(file.id));
  const drift = files
    .filter((file) => {
      const row = applied.find((item) => item.id === file.id);
      return row ? row.checksum !== file.checksum : false;
    })
    .map((file) => file.filename);
  return { pending, applied, drift };
}

/* -------------------------------------------------------------------------- */
/*                         SQL portability helpers                            */
/* -------------------------------------------------------------------------- */

/**
 * Splits a migration file into individual statements.
 *
 * Handles `--` line comments, `/* … *​/` block comments and single-quoted string
 * literals so that semicolons inside text values do not split a statement.
 * Dollar-quoted PostgreSQL blocks are intentionally NOT supported — keep
 * migrations free of procedural SQL, or place them in a dialect directory.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inSingle = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    const next = sql[i + 1];

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
        current += char;
      }
      continue;
    }
    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (!inSingle) {
      if (char === "-" && next === "-") {
        inLineComment = true;
        i += 1;
        continue;
      }
      if (char === "/" && next === "*") {
        inBlockComment = true;
        i += 1;
        continue;
      }
    }
    if (char === "'") {
      // Escaped quote inside a literal: '' stays inside the string.
      if (inSingle && next === "'") {
        current += "''";
        i += 1;
        continue;
      }
      inSingle = !inSingle;
      current += char;
      continue;
    }
    if (char === ";" && !inSingle) {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = "";
      continue;
    }
    current += char;
  }

  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
}

/**
 * Translates the portable schema dialect into a concrete one.
 * Replacements are applied outside string literals only.
 */
export function translate(sql: string, dialect: SqlDialect): string {
  if (dialect === "sqlite") return sql;
  return sql
    .split(/(\n)/)
    .map((line) => translateLine(line))
    .join("");
}

function translateLine(line: string): string {
  // Preserve leading comment lines untouched.
  if (/^\s*--/.test(line)) return line;
  return replaceOutsideStrings(line, [
    // Postgres has no REAL alias for float8 columns; DOUBLE PRECISION is portable.
    [/\bREAL\b/g, "DOUBLE PRECISION"],
    // Monetary and counter columns stay integer, widened for headroom.
    [/\bINTEGER\b/g, "BIGINT"],
  ]);
}

/** Applies replacements only to SQL code, never to text inside '…' literals. */
export function replaceOutsideStrings(
  line: string,
  replacements: [RegExp, string][],
): string {
  type Token = { type: "code" | "string"; text: string };
  const tokens: Token[] = [];
  let code = "";
  let i = 0;

  while (i < line.length) {
    const char = line[i];
    if (char !== "'") {
      code += char;
      i += 1;
      continue;
    }
    // Start of a string literal: flush pending code, then consume the literal.
    if (code) {
      tokens.push({ type: "code", text: code });
      code = "";
    }
    let literal = "'";
    i += 1;
    while (i < line.length) {
      if (line[i] === "'") {
        if (line[i + 1] === "'") {
          literal += "''"; // escaped quote stays inside the literal
          i += 2;
          continue;
        }
        literal += "'";
        i += 1;
        break;
      }
      literal += line[i];
      i += 1;
    }
    tokens.push({ type: "string", text: literal });
  }
  if (code) tokens.push({ type: "code", text: code });

  return tokens
    .map((token) => {
      if (token.type === "string") return token.text;
      let value = token.text;
      for (const [pattern, replacement] of replacements) {
        value = value.replace(pattern, replacement);
      }
      return value;
    })
    .join("");
}
