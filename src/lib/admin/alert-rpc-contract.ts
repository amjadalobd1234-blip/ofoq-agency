/**
 * The contract between the staff alert centre and the database.
 *
 * One list, used twice:
 *  1. the diagnostics endpoint compares it with what PostgREST exposes (see
 *     src/lib/supabase/postgrest-introspection.ts), and
 *  2. the tests pin it against the SQL in db/migrations/supabase/0007_admin_alerts.sql.
 *
 * Argument names matter: PostgREST resolves a function by NAME *and* parameter
 * names. A function installed as `ofoq_admin_alert_details(p_id text)` is
 * callable from the SQL Editor (`SELECT ofoq_admin_alert_details('<id>')`) but
 * NOT through `client.rpc("ofoq_admin_alert_details", { p_alert_id })` — the
 * API answers PGRST202 «Could not find the function … in the schema cache»,
 * which is exactly the message the staff page used to show.
 */
import type { RpcSurface } from "@/lib/supabase/postgrest-introspection";

export interface AlertRpcExpectation {
  name: string;
  /** Argument names, in signature order, as the routes send them. */
  args: readonly string[];
  /** Where the definition lives. */
  sql: string;
  purpose: { ar: string; en: string };
}

export const ALERT_SQL_FILE = "db/migrations/supabase/0007_admin_alerts.sql";

export const ALERT_RPC_EXPECTATIONS: readonly AlertRpcExpectation[] = [
  {
    name: "ofoq_admin_alerts",
    args: ["p_status", "p_limit", "p_offset"],
    sql: ALERT_SQL_FILE,
    purpose: { ar: "قائمة التنبيهات (صفحة التنبيهات)", en: "The alert inbox list" },
  },
  {
    name: "ofoq_admin_alert_details",
    args: ["p_alert_id"],
    sql: ALERT_SQL_FILE,
    purpose: { ar: "تفاصيل تنبيه واحد مع المحادثة", en: "One alert with its client context" },
  },
  {
    name: "ofoq_admin_acknowledge_alert",
    args: ["p_alert_id"],
    sql: ALERT_SQL_FILE,
    purpose: { ar: "تأكيد المتابعة", en: "Acknowledge" },
  },
  {
    name: "ofoq_admin_resolve_alert",
    args: ["p_alert_id", "p_note"],
    sql: ALERT_SQL_FILE,
    purpose: { ar: "حل التنبيه", en: "Resolve" },
  },
  {
    name: "ofoq_admin_reply_to_client",
    args: ["p_alert_id", "p_body", "p_language"],
    sql: ALERT_SQL_FILE,
    purpose: { ar: "الرد على العميل", en: "Reply to the client" },
  },
];

export type AlertRpcStatus = "exposed" | "missing" | "signature_mismatch" | "unknown";

export interface AlertRpcVerdict {
  name: string;
  status: AlertRpcStatus;
  expectedArgs: string[];
  /** Argument names the Data API reports for this project. */
  installedArgs: string[];
  /** Expected and not installed (the reason a named-argument call fails). */
  missingArgs: string[];
  /** Installed but never sent by the app (informational). */
  unexpectedArgs: string[];
  detail: { ar: string; en: string };
}

function detailFor(status: AlertRpcStatus, expected: AlertRpcExpectation, installed: string[], missing: string[]): { ar: string; en: string } {
  if (status === "exposed") {
    return { ar: "متاحة عبر الـ API بالأسماء الصحيحة.", en: "Exposed through the Data API with the expected argument names." };
  }
  if (status === "missing") {
    return {
      ar: `غير موجودة في هذا المشروع — طبّق ${expected.sql} ثم نفّذ NOTIFY pgrst, 'reload schema';`,
      en: `Not present on this project — apply ${expected.sql}, then run NOTIFY pgrst, 'reload schema';`,
    };
  }
  if (status === "signature_mismatch") {
    return {
      ar: `موجودة لكن بأسماء وسائط مختلفة (المطلوب: ${expected.args.join(", ")} — المثبّت: ${installed.join(", ") || "بلا وسائط"}). الحل: أسقط النسخة القديمة ثم أعد تطبيق ${expected.sql}.`,
      en: `Installed with different parameter names (expected ${expected.args.join(", ")}, installed ${installed.join(", ") || "none"}). Drop the old overload, then re-apply ${expected.sql}.`,
    };
  }
  return {
    ar: `تعذّر التحقق (${missing.join(", ") || "غير معروف"}).`,
    en: `Could not be verified (${missing.join(", ") || "unknown"}).`,
  };
}

/** Compares one expectation against the surface PostgREST reported. */
export function verifyAlertRpc(expectation: AlertRpcExpectation, surface: RpcSurface | null, surfaceReadable: boolean): AlertRpcVerdict {
  const expectedArgs = [...expectation.args];
  const installedArgs = surface ? surface.parameters.map((parameter) => parameter.name) : [];
  if (!surface) {
    const status: AlertRpcStatus = surfaceReadable ? "missing" : "unknown";
    return {
      name: expectation.name,
      status,
      expectedArgs,
      installedArgs,
      missingArgs: expectedArgs,
      unexpectedArgs: [],
      detail: detailFor(status, expectation, installedArgs, expectedArgs),
    };
  }
  const missingArgs = expectedArgs.filter((arg) => !installedArgs.includes(arg));
  const unexpectedArgs = installedArgs.filter((arg) => !expectedArgs.includes(arg));
  const status: AlertRpcStatus = missingArgs.length > 0 ? "signature_mismatch" : "exposed";
  return {
    name: expectation.name,
    status,
    expectedArgs,
    installedArgs,
    missingArgs,
    unexpectedArgs,
    detail: detailFor(status, expectation, installedArgs, missingArgs),
  };
}

/** Every alert RPC, in the order the UI uses them. */
export function verifyAlertRpcs(surfaces: Map<string, RpcSurface>, surfaceReadable = true): AlertRpcVerdict[] {
  return ALERT_RPC_EXPECTATIONS.map((expectation) => verifyAlertRpc(expectation, surfaces.get(expectation.name) ?? null, surfaceReadable));
}

/** True when every alert RPC is exposed with the argument names the app sends. */
export function allAlertRpcsExposed(verdicts: readonly AlertRpcVerdict[]): boolean {
  return verdicts.every((verdict) => verdict.status === "exposed");
}
