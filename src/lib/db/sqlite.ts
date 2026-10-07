import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import {
  DbError,
  type DbDriver,
  type Row,
  type RunResult,
  type SqlDialect,
  type SqlValue,
  normaliseValue,
} from "./types";

/**
 * SQLite driver (default storage engine).
 *
 * Uses `better-sqlite3`, which ships prebuilt binaries and needs no external
 * service — ideal for local development and small self-hosted deployments.
 *
 * Concurrency model: SQLite allows a single writer, so every statement is
 * funnelled through a promise-chain mutex. That keeps multi-statement
 * transactions atomic even though the surrounding application code is async.
 */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result as Promise<T>;
  }
}

export interface SqliteDriverOptions {
  filename: string;
  /** Enables WAL + relaxed sync; disabled for in-memory/tests. */
  wal?: boolean;
}

export class SqliteDriver implements DbDriver {
  readonly dialect: SqlDialect = "sqlite";
  readonly target: string;

  private readonly db: Database.Database;
  private readonly mutex = new Mutex();
  private depth = 0;
  private closed = false;
  /**
   * True while a transaction body is executing inside the mutex. Statements
   * issued by that body must run directly (the mutex is already held by this
   * driver), otherwise the call would queue behind itself and deadlock.
   */
  private reentrant = false;

  constructor(options: SqliteDriverOptions) {
    this.target = options.filename;
    if (options.filename !== ":memory:") {
      fs.mkdirSync(path.dirname(path.resolve(options.filename)), { recursive: true });
    }
    this.db = new Database(options.filename);
    this.db.pragma("foreign_keys = ON");
    if (options.wal !== false && options.filename !== ":memory:") {
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = NORMAL");
    }
    this.db.pragma("busy_timeout = 5000");
  }

  /** Serialises access unless the current task already holds the mutex. */
  private guarded<T>(fn: () => T): Promise<T> {
    if (this.reentrant) return Promise.resolve().then(fn);
    return this.mutex.run(fn);
  }

  async query<T = Row>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    return this.guarded(() => {
      try {
        return this.db.prepare(sql).all(...params.map(normaliseValue)) as T[];
      } catch (error) {
        throw new DbError(formatError(error), sql, error);
      }
    });
  }

  async get<T = Row>(sql: string, params: SqlValue[] = []): Promise<T | undefined> {
    return this.guarded(() => {
      try {
        return this.db.prepare(sql).get(...params.map(normaliseValue)) as T | undefined;
      } catch (error) {
        throw new DbError(formatError(error), sql, error);
      }
    });
  }

  async run(sql: string, params: SqlValue[] = []): Promise<RunResult> {
    return this.guarded(() => {
      try {
        const info = this.db.prepare(sql).run(...params.map(normaliseValue));
        return { changes: info.changes, lastInsertRowid: Number(info.lastInsertRowid) };
      } catch (error) {
        throw new DbError(formatError(error), sql, error);
      }
    });
  }

  async exec(sql: string): Promise<void> {
    return this.guarded(() => {
      try {
        this.db.exec(sql);
      } catch (error) {
        throw new DbError(formatError(error), sql, error);
      }
    });
  }

  async transaction<T>(fn: (tx: DbDriver) => Promise<T>): Promise<T> {
    if (this.depth > 0) {
      // Already inside a transaction: join it instead of nesting.
      return fn(this);
    }
    return this.mutex.run(async () => {
      this.db.prepare("BEGIN IMMEDIATE").run();
      this.depth += 1;
      this.reentrant = true;
      try {
        const result = await fn(this);
        this.db.prepare("COMMIT").run();
        return result;
      } catch (error) {
        try {
          this.db.prepare("ROLLBACK").run();
        } catch {
          // Rollback failures are surfaced through the original error.
        }
        throw error;
      } finally {
        this.reentrant = false;
        this.depth -= 1;
      }
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.mutex.run(() => {
      this.db.close();
      return true;
    });
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
