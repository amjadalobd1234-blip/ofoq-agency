import {
  DbError,
  type DbDriver,
  type Row,
  type RunResult,
  type SqlDialect,
  type SqlValue,
  normaliseRow,
  normaliseValue,
} from "./types";

/**
 * PostgreSQL driver — the documented scale-out path.
 *
 * It is provided so the platform can move to PostgreSQL by setting
 * DATABASE_DRIVER=postgres and DATABASE_URL, without changes anywhere else.
 * The `pg` driver is imported lazily so SQLite-only deployments do not open a
 * PostgreSQL connection. It is included as a runtime dependency for Supabase
 * deployments.
 *
 * NOTE: this driver should be verified against a staging PostgreSQL database
 * before production use; `npm test` covers generated schema consistency but
 * does not replace a live database migration.
 */
export class PostgresDriver implements DbDriver {
  readonly dialect: SqlDialect = "postgres";
  readonly target: string;

  private readonly pool: PostgresPool;
  private depth = 0;

  private constructor(pool: PostgresPool, target: string) {
    this.pool = pool;
    this.target = target;
  }

  static async create(connectionString: string): Promise<PostgresDriver> {
    let pgModule: {
      Pool: new (config: { connectionString: string }) => PostgresPool;
      types?: { setTypeParser(oid: number, parser: (value: string) => unknown): void };
    };
    try {
      // @ts-expect-error -- pg is imported lazily so a SQLite deployment never
      // loads it. It stays a runtime `require` (see `serverExternalPackages`
      // in next.config.ts) and the bundler therefore traces node_modules/pg
      // into the deployed function; a `webpackIgnore` import would be invisible
      // to that trace and the driver would fail on a serverless deployment.
      pgModule = (await import("pg")) as never;
    } catch (error) {
      throw new Error(
        "PostgreSQL was selected (DATABASE_DRIVER=postgres), but the 'pg' package is not installed. " +
          "Install project dependencies with npm install.",
        { cause: error },
      );
    }
    // node-postgres normally returns int8 (OID 20) as a string. The schema uses
    // BIGINT for SQLite INTEGER values, which the application expects as JS
    // numbers. Preserve out-of-range values rather than silently losing precision.
    pgModule.types?.setTypeParser(20, parsePostgresInt8);
    const pool = new pgModule.Pool({ connectionString });
    // Fail fast with a clear message when the database is unreachable.
    await pool.query("SELECT 1");
    return new PostgresDriver(pool, redact(connectionString));
  }

  async query<T = Row>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    const result = await this.execute(sql, params);
    return result.rows.map((row) => normaliseRow<T>(row));
  }

  async get<T = Row>(sql: string, params: SqlValue[] = []): Promise<T | undefined> {
    const rows = await this.query<T>(sql, params);
    return rows[0];
  }

  async run(sql: string, params: SqlValue[] = []): Promise<RunResult> {
    const result = await this.execute(sql, params);
    return { changes: result.rowCount ?? 0 };
  }

  async exec(sql: string): Promise<void> {
    await this.execute(sql, []);
  }

  async transaction<T>(fn: (tx: DbDriver) => Promise<T>): Promise<T> {
    if (this.depth > 0) return fn(this);
    const client = await this.pool.connect();
    this.depth += 1;
    try {
      await client.query("BEGIN");
      const txDriver = new PostgresTransactionDriver(client, this.target);
      const result = await fn(txDriver);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Original error wins.
      }
      throw error;
    } finally {
      this.depth -= 1;
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async execute(
    sql: string,
    params: SqlValue[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> {
    const { text, values } = toPositional(sql, params);
    try {
      const result = await this.pool.query(text, values);
      return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new DbError(message, sql, error);
    }
  }
}

/** Same contract as the pool, but bound to a single client inside a transaction. */
class PostgresTransactionDriver implements DbDriver {
  readonly dialect: SqlDialect = "postgres";

  constructor(
    private readonly client: PostgresClient,
    readonly target: string,
  ) {}

  async query<T = Row>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    const { text, values } = toPositional(sql, params);
    const result = await this.client.query(text, values);
    return (result.rows as Record<string, unknown>[]).map((row) => normaliseRow<T>(row));
  }

  async get<T = Row>(sql: string, params: SqlValue[] = []): Promise<T | undefined> {
    const rows = await this.query<T>(sql, params);
    return rows[0];
  }

  async run(sql: string, params: SqlValue[] = []): Promise<RunResult> {
    const { text, values } = toPositional(sql, params);
    const result = await this.client.query(text, values);
    return { changes: result.rowCount ?? 0 };
  }

  async exec(sql: string): Promise<void> {
    await this.client.query(sql);
  }

  async transaction<T>(fn: (tx: DbDriver) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async close(): Promise<void> {
    // The owning driver closes the pool.
  }
}

interface PostgresQueryResult {
  rows: unknown[];
  rowCount: number | null;
}

interface PostgresClient {
  query(text: string, values?: unknown[]): Promise<PostgresQueryResult>;
  release(): void;
}

interface PostgresPool {
  query(text: string, values?: unknown[]): Promise<PostgresQueryResult>;
  connect(): Promise<PostgresClient>;
  end(): Promise<void>;
}

/**
 * Rewrites `?` placeholders into `$1, $2, …` while ignoring placeholders that
 * appear inside string literals (the schema stores such text, e.g. copy).
 */
export function toPositional(
  sql: string,
  params: SqlValue[],
): { text: string; values: SqlValue[] } {
  let index = 0;
  let out = "";
  let inSingle = false;
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    if (char === "'") {
      inSingle = !inSingle;
      out += char;
      continue;
    }
    if (char === "?" && !inSingle) {
      index += 1;
      out += `$${index}`;
      continue;
    }
    out += char;
  }
  return { text: out, values: params.map(normaliseValue) };
}

export function parsePostgresInt8(value: string): number | string {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : value;
}

function redact(connectionString: string): string {
  return connectionString.replace(/:\/\/([^:]+):([^@]+)@/, "://$1:***@");
}
