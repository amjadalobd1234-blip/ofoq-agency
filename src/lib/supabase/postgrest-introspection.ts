/**
 * PostgREST introspection — «which of the RPCs the app calls does this project
 * actually expose to the Data API, and with which argument names?»
 *
 * Why this module exists
 * ----------------------
 * «The RPC works in the SQL Editor but not from the site» has three causes that
 * look identical from the browser (PGRST202 — «Could not find the function … in
 * the schema cache»):
 *
 *   a) the function was never installed on the project the API talks to,
 *   b) it was installed with different argument names / arity, or
 *   c) it exists, but the PostgREST schema cache predates it.
 *
 * `GET {SUPABASE_URL}/rest/v1/` answers all three: PostgREST renders its
 * OpenAPI document for the *calling role*, listing every function it can expose
 * together with the exact parameter names. Comparing that list with the
 * `p_*` arguments the application sends turns a guess into a diff.
 */
import type { SupabasePublicConfig } from "./config";

export interface RpcParameter {
  name: string;
  type: string | null;
  required: boolean;
}

export interface RpcSurface {
  name: string;
  parameters: RpcParameter[];
  methods: string[];
}

export interface RestSurfaceReport {
  ok: boolean;
  /** HTTP status of the OpenAPI request. */
  status: number | null;
  /** `Server` header, e.g. `postgrest/12.2.3`. */
  serverVersion: string | null;
  rpcCount: number;
  rpcs: Map<string, RpcSurface>;
  /** Set when the document could not be read (network, 401, unexpected body). */
  error: string | null;
}

/** Parameters PostgREST adds to every function path; they are not arguments. */
const RESERVED_PARAMETERS = new Set([
  "select", "columns", "order", "limit", "offset", "on_conflict", "and", "or", "not",
  "Prefer", "Content-Type", "Accept", "apikey", "Authorization", "Range", "Range-Unit",
  "id", "ids",
]);

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readParameters(operation: UnknownRecord): RpcParameter[] {
  const found = new Map<string, RpcParameter>();

  const fromList = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const entry of list) {
      if (!isRecord(entry)) continue;
      const name = typeof entry.name === "string" ? entry.name : null;
      if (!name || RESERVED_PARAMETERS.has(name) || entry.in === "header") continue;
      found.set(name, {
        name,
        type: typeof entry.type === "string" ? entry.type : typeof entry.format === "string" ? entry.format : null,
        required: entry.required === true,
      });
    }
  };

  // PostgREST ≤ 11 keeps parameters on the operation; 12+ moved them into the
  // request body schema. Both shapes are read so the report survives an upgrade.
  fromList(operation.parameters);
  const requestBody = operation.requestBody;
  if (isRecord(requestBody)) {
    const content = requestBody.content;
    if (isRecord(content)) {
      const json = content["application/json"];
      if (isRecord(json) && isRecord(json.schema)) {
        const schema = json.schema;
        fromList(schema.parameters);
        const properties = schema.properties;
        const required = Array.isArray(schema.required) ? schema.required.filter((name): name is string => typeof name === "string") : [];
        if (isRecord(properties)) {
          for (const [name, value] of Object.entries(properties)) {
            if (RESERVED_PARAMETERS.has(name)) continue;
            const property = isRecord(value) ? value : {};
            found.set(name, {
              name,
              type: typeof property.type === "string" ? property.type : typeof property.format === "string" ? property.format : null,
              required: required.includes(name),
            });
          }
        }
      }
    }
  }

  return [...found.values()];
}

/** Parses the OpenAPI document into the RPC surface only. */
export function parseRestSurface(document: unknown): Map<string, RpcSurface> {
  const rpcs = new Map<string, RpcSurface>();
  if (!isRecord(document)) return rpcs;
  const paths = document.paths;
  if (!isRecord(paths)) return rpcs;

  for (const [path, value] of Object.entries(paths)) {
    const match = /^\/rpc\/([A-Za-z0-9_]+)$/.exec(path);
    if (!match || !isRecord(value)) continue;
    const name = match[1];
    const methods: string[] = [];
    const parameters = new Map<string, RpcParameter>();
    for (const method of ["get", "post"]) {
      const operation = value[method];
      if (!isRecord(operation)) continue;
      methods.push(method.toUpperCase());
      for (const parameter of readParameters(operation)) parameters.set(parameter.name, parameter);
    }
    if (methods.length === 0) continue;
    rpcs.set(name, { name, parameters: [...parameters.values()], methods });
  }
  return rpcs;
}

/**
 * Reads the Data API's own description of itself, **as the signed-in user**, so
 * the answer reflects what that role may actually execute.
 */
export async function fetchRestSurface(
  config: SupabasePublicConfig,
  accessToken: string | null,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<RestSurfaceReport> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    apikey: config.anonKey,
    Accept: "application/openapi+json",
  };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  try {
    const response = await fetchImpl(`${config.url}/rest/v1/`, {
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(options.timeoutMs ?? 8_000),
    });
    const serverVersion = response.headers.get("server");
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        serverVersion,
        rpcCount: 0,
        rpcs: new Map(),
        error: `The Data API answered ${response.status}. Check NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY (they must belong to the same project as the session).`,
      };
    }
    const document = (await response.json()) as unknown;
    const rpcs = parseRestSurface(document);
    return { ok: true, status: response.status, serverVersion, rpcCount: rpcs.size, rpcs, error: null };
  } catch (error) {
    return {
      ok: false,
      status: null,
      serverVersion: null,
      rpcCount: 0,
      rpcs: new Map(),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
