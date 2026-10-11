/**
 * RPC failure diagnosis — turns one PostgREST error into the next thing to
 * check, and into a stable machine code the staff UI can show.
 *
 * Why this module exists
 * ----------------------
 * `rpcFailureResponse()` used to answer every schema-level error with
 * «Supabase portal migration is not installed yet». That single sentence hid
 * four very different situations, and the owner has hit at least three of them:
 *
 *   PGRST202  the Data API cannot see the function (never applied, applied to
 *             another project, or the PostgREST schema cache is stale)
 *   42883     Postgres answered «no function with THIS argument list» — the
 *             installed overload has different parameter names or arity
 *   42P01     a table inside the function does not exist (partial migration)
 *   42501     RLS/grants refused the call, not the schema
 *
 * The public message stays truthful and short; the log line carries the full
 * error plus the exact SQL that fixes it. Tokens, bodies and row data are never
 * part of either one.
 */
/** A PostgREST/PostgreSQL error, kept whole: code, message, details and hint. */
export interface PostgrestErrorLike {
  code?: string | null;
  message?: string | null;
  details?: string | null;
  hint?: string | null;
}

/** How a failed RPC should be understood. */
export type RpcFailureKind =
  | "not_installed"
  | "signature_mismatch"
  | "stale_schema_cache"
  | "wrong_project"
  | "missing_table"
  | "permission_denied"
  | "inactive_session"
  | "not_found"
  | "invalid_input"
  | "throttled"
  | "unknown";

export interface RpcFailureContext {
  /** The RPC that failed, e.g. `ofoq_admin_alert_details`. */
  rpc: string;
  /**
   * The arguments the application sent, already redacted for the log
   * (`{ p_alert_id: "<alert id>" }`). Values must never be customer data.
   */
  args?: Record<string, string>;
  /** Project ref inside the caller's access token, when it could be read. */
  sessionProjectRef?: string | null;
  /** Project ref of NEXT_PUBLIC_SUPABASE_URL. */
  configProjectRef?: string | null;
  /** Adds the actionable hint to the browser response (staff-only routes). */
  exposeHint?: boolean;
  /**
   * What was actually being read when it is not the RPC itself — for example
   * `public.users (id, name, email, role, status, locale)`.
   *
   * The staff routes read the caller's profile row *before* they call any RPC.
   * A missing column or a stale schema cache on that table produces the same
   * PostgREST codes as a missing function, so the report must name the table it
   * really failed on — otherwise «the migration is not installed» points the
   * reader at the wrong SQL file.
   */
  resource?: string;
  /** Replaces the machine code, e.g. `PROFILE_READ_FAILED` for a table read. */
  codeOverride?: string;
  /** Replaces the one sentence the browser receives. */
  messageOverride?: string;
}

export interface RpcFailureReport {
  kind: RpcFailureKind;
  /** Stable, log- and UI-friendly identifier, e.g. `RPC_NOT_INSTALLED`. */
  code: string;
  status: number;
  /** The only sentence the browser receives. */
  publicMessage: string;
  /** Short, actionable line for a signed-in staff member (never for clients). */
  publicHint: string | null;
  /** One-line explanation written next to the raw error in the log. */
  explanation: string;
  /** Copy-pasteable SQL / config step. Log-only unless `exposeHint` is set. */
  hint: string;
}

const SETUP_FILE = "docs/setup/supabase-setup.sql";
const ALERT_MIGRATION = "db/migrations/supabase/0007_admin_alerts.sql";

const NOT_INSTALLED_MESSAGE =
  "Supabase portal migration is not installed yet. Apply docs/setup/supabase-setup.sql in the Supabase SQL Editor.";

const RELOAD_SQL = "NOTIFY pgrst, 'reload schema';";

/** Short request id used to correlate a browser error with one log line. */
export function newRequestId(): string {
  const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(16).slice(2);
  return random.replace(/-/g, "").slice(0, 12);
}

/**
 * Reads the argument list PostgREST looked for out of its own message, e.g.
 * `Could not find the function public.ofoq_admin_alert_details(p_alert_id) in
 * the schema cache` → `p_alert_id`.
 */
export function argumentsFromPostgrestMessage(message: string | null | undefined): string | null {
  const match = /function\s+public\.[a-z0-9_]+\(([^)]*)\)/i.exec(message ?? "");
  return match ? match[1].trim() : null;
}

function installedSignaturesSql(rpc: string): string {
  return [
    "SELECT p.oid::regprocedure AS signature, pg_get_function_arguments(p.oid) AS args,",
    "       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_can_execute",
    "FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace",
    `WHERE n.nspname = 'public' AND p.proname = '${rpc}';`,
  ].join(" ");
}

/**
 * Classifies one failed RPC call, then names the resource it failed on.
 *
 * The order matters: a project mismatch explains a PGRST202 better than a
 * missing migration does, and the two are indistinguishable from the error
 * alone — so the session's own project ref is checked first.
 */
export function diagnoseRpcFailure(error: PostgrestErrorLike, context: RpcFailureContext): RpcFailureReport {
  return applyContext(classifyRpcFailure(error, context), context);
}

/**
 * Rewrites the report when the caller was reading something other than the RPC
 * (see `RpcFailureContext.resource`). Kept separate so the classification stays
 * one readable switch over PostgREST's codes.
 */
function applyContext(report: RpcFailureReport, context: RpcFailureContext): RpcFailureReport {
  if (!context.resource && !context.codeOverride && !context.messageOverride) return report;
  return {
    ...report,
    code: context.codeOverride ?? report.code,
    publicMessage: context.messageOverride ?? report.publicMessage,
    explanation: context.resource
      ? report.explanation.replaceAll(`public.${context.rpc}`, context.resource)
      : report.explanation,
    hint: context.resource ? `${report.hint} Reading: ${context.resource}.` : report.hint,
  };
}

function classifyRpcFailure(error: PostgrestErrorLike, context: RpcFailureContext): RpcFailureReport {
  const code = (error.code ?? "").trim();
  const message = (error.message ?? "").trim();
  const sawProjectMismatch = Boolean(
    context.sessionProjectRef && context.configProjectRef && context.sessionProjectRef !== context.configProjectRef,
  );
  const calledArgs = argumentsFromPostgrestMessage(message);

  const notInstalled = (reason: string): RpcFailureReport => ({
    kind: "not_installed",
    code: "RPC_NOT_INSTALLED",
    status: 503,
    publicMessage: NOT_INSTALLED_MESSAGE,
    publicHint: "Open /api/debug/alerts while signed in — it lists which of the ofoq_admin_* RPCs this project actually exposes.",
    explanation: `${reason}. The Data API does not expose public.${context.rpc}${calledArgs ? `(${calledArgs})` : ""}.`,
    hint: [
      `Re-run ${ALERT_MIGRATION} (or the whole ${SETUP_FILE} bundle) in the Supabase SQL Editor.`,
      `The file now ends with a verification report and ${RELOAD_SQL} — a stale PostgREST schema cache answers PGRST202 even when the function exists.`,
      `Verify with: ${installedSignaturesSql(context.rpc)}`,
    ].join(" "),
  });

  if (code === "PGRST202") {
    if (sawProjectMismatch) {
      return {
        kind: "wrong_project",
        code: "SESSION_PROJECT_MISMATCH",
        status: 503,
        publicMessage: "Your session belongs to a different Supabase project than this deployment is configured for. Sign in again after the project's URL and anon key are updated.",
        publicHint: "The auth cookie's `ref` claim and NEXT_PUBLIC_SUPABASE_URL do not match — see /api/debug/alerts.",
        explanation: `PGRST202 on public.${context.rpc}, and the session token was minted for project ${context.sessionProjectRef} while NEXT_PUBLIC_SUPABASE_URL points at ${context.configProjectRef}`,
        hint: `Sign out, set NEXT_PUBLIC_SUPABASE_URL/NEXT_PUBLIC_SUPABASE_ANON_KEY to project ${context.sessionProjectRef} (then redeploy — NEXT_PUBLIC_* is inlined at build time), or apply the migrations to ${context.configProjectRef}.`,
      };
    }
    return notInstalled(`PGRST202 — the API answered "${message || "function not found in the schema cache"}"`);
  }

  if (code === "42883" || /\bfunction\b.*\bdoes not exist\b/i.test(message)) {
    return {
      kind: "signature_mismatch",
      code: "RPC_SIGNATURE_MISMATCH",
      status: 503,
      publicMessage: `The database has a version of this action with a different signature (${context.rpc}). Apply the current SQL file and try again.`,
      publicHint: "Run the signature query in /api/debug/alerts to compare the installed argument list with the one the app sends.",
      explanation: `42883 — the argument list the app sends does not match any installed overload of public.${context.rpc} (sent: ${Object.keys(context.args ?? {}).join(", ") || "no named args"})`,
      hint: `Compare with: ${installedSignaturesSql(context.rpc)} If an old overload exists with different names, drop it (DROP FUNCTION public.${context.rpc}(<installed types>);) and re-run ${ALERT_MIGRATION}.`,
    };
  }

  if (code === "PGRST204") {
    return {
      kind: "stale_schema_cache",
      code: "SCHEMA_CACHE_STALE",
      status: 503,
      publicMessage: NOT_INSTALLED_MESSAGE,
      publicHint: "The table columns changed but the Data API still holds the old shape. Reload the schema cache (see the log hint) and try again.",
      explanation: `PGRST204 — a column of the tables behind public.${context.rpc} is missing from the PostgREST schema cache`,
      hint: `Reload the cache with ${RELOAD_SQL} (Supabase → Settings → API → “Reload schema” does the same), then re-run ${SETUP_FILE} if the column really is missing.`,
    };
  }

  if (code === "42P01" || /relation .* does not exist/i.test(message)) {
    return {
      kind: "missing_table",
      code: "TABLE_NOT_INSTALLED",
      status: 503,
      publicMessage: NOT_INSTALLED_MESSAGE,
      publicHint: "A table the action reads is missing on this project. Apply the setup SQL file.",
      explanation: `42P01 — a relation behind public.${context.rpc} does not exist (the portal schema was applied partially)`,
      hint: `Apply ${SETUP_FILE} in full (it is re-runnable) and then run ${RELOAD_SQL}.`,
    };
  }

  if (code === "42501") {
    return {
      kind: "permission_denied",
      code: "RPC_FORBIDDEN",
      status: 403,
      publicMessage: "You do not have permission for this data.",
      publicHint: null,
      explanation: `42501 — the caller is not allowed to call public.${context.rpc} or to read behind it`,
      hint: `Either the account is not staff (public.ofoq_is_staff() must be true) or EXECUTE was never granted: GRANT EXECUTE ON FUNCTION public.${context.rpc}(…) TO authenticated;`,
    };
  }

  if (code === "28000") {
    return {
      kind: "inactive_session",
      code: "SESSION_INACTIVE",
      status: 401,
      publicMessage: "Your session is not active. Sign in again or contact the agency.",
      publicHint: null,
      explanation: `28000 — the RPC did not see an ACTIVE platform account (auth.uid() NULL or users.status <> 'ACTIVE')`,
      hint: `Check the profile row: SELECT id, email, role, status FROM public.users WHERE id = '<auth user id>';`,
    };
  }

  if (code === "P0002") {
    return {
      kind: "not_found",
      code: "RECORD_NOT_FOUND",
      status: 404,
      publicMessage: "The requested record could not be found.",
      publicHint: null,
      explanation: `P0002 — public.${context.rpc} raised «not found» for the supplied id`,
      hint: `Confirm the id exists in public.alerts; the id in the URL is matched against alerts.id (not a conversation id).`,
    };
  }

  if (code === "22023") {
    return {
      kind: "invalid_input",
      code: "INVALID_INPUT",
      status: 400,
      publicMessage: "The submitted data is invalid.",
      publicHint: null,
      explanation: `22023 — public.${context.rpc} rejected an argument value`,
      hint: `Re-check the submitted values against the function's own validation (lengths, enums).`,
    };
  }

  if (code === "P0001") {
    return {
      kind: "throttled",
      code: "RATE_LIMITED",
      status: 429,
      publicMessage: "Please wait briefly before sending another message.",
      publicHint: null,
      explanation: `P0001 — public.${context.rpc} raised a deliberate pause (rate limit or dedupe)`,
      hint: `Nothing to fix: the function is protecting the conversation.`,
    };
  }

  return {
    kind: "unknown",
    code: "RPC_FAILED",
    status: 502,
    publicMessage: "Unable to load platform data right now.",
    publicHint: "Open /api/debug/alerts while signed in for the raw error of this project.",
    explanation: `unclassified failure of public.${context.rpc} (code ${code || "none"})`,
    hint: "Compare the log line with the migration and the project's exposed functions.",
  };
}

/**
 * Keeps the public shape of the response the rest of the code already sends,
 * and adds the machine code / hint / request id a staff member can quote.
 */
export function rpcFailurePayload(report: RpcFailureReport, requestId: string): Record<string, string> {
  const payload: Record<string, string> = { error: report.publicMessage, code: report.code, requestId };
  if (report.publicHint) payload.hint = report.publicHint;
  return payload;
}
