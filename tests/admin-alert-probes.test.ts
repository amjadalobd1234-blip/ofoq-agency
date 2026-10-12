/**
 * The diagnostics that answer «why does the button not respond?» without a
 * redeploy — and the reason they are safe to run on a live project.
 *
 * `GET /api/debug/alerts` probes both write actions with an alert id that cannot
 * exist, so the verdict is either «the argument names resolve» (P0002) or «they
 * do not» (PGRST202) — and nothing is written. These tests pin that reading, and
 * pin the SQL property that makes it write-free.
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  ACTION_PROBE_ALERT_ID,
  PROBED_ACTIONS,
  interpretActionProbe,
  probeArguments,
  verdictForReplyability,
} from "../src/lib/admin/alert-action-probes";
import { ALERT_ACTION_RPC } from "../src/lib/admin/alert-route-guard";

const migration = fs.readFileSync(path.join(process.cwd(), "db", "migrations", "supabase", "0007_admin_alerts.sql"), "utf8");

describe("action probes", () => {
  it("uses a nil alert id and the same argument names as the buttons", () => {
    expect(ACTION_PROBE_ALERT_ID).toBe("00000000-0000-0000-0000-000000000000");
    for (const action of PROBED_ACTIONS) {
      expect(Object.keys(probeArguments(action, ACTION_PROBE_ALERT_ID)).sort()).toEqual([...ALERT_ACTION_RPC[action].args].sort());
    }
    expect(probeArguments("reply", ACTION_PROBE_ALERT_ID)).toMatchObject({ p_language: "ar" });
    expect(probeArguments("resolve", ACTION_PROBE_ALERT_ID)).toMatchObject({ p_note: null });
  });

  it("is write-free by construction: the alert lookup precedes the message insert", () => {
    for (const name of ["ofoq_admin_reply_to_client", "ofoq_admin_resolve_alert"]) {
      const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
      const end = migration.indexOf("$function$;", start);
      const body = migration.slice(start, end);
      const lookup = body.indexOf("FROM public.alerts AS a");
      const write = name.endsWith("reply_to_client")
        ? body.indexOf("INSERT INTO public.messages")
        : body.indexOf("UPDATE public.alerts");
      expect(lookup, `${name} must look the alert up`).toBeGreaterThan(-1);
      expect(write, `${name} must write`).toBeGreaterThan(-1);
      // A nil id matches no row → the function raises P0002 before the write is
      // ever reached, which is what makes the diagnostic safe to run.
      expect(lookup, `${name}: the lookup must run before the write`).toBeLessThan(write);
      expect(body).toContain("RAISE EXCEPTION");
    }
  });

  it("reads P0002 as «the argument names are correct»", () => {
    const verdict = interpretActionProbe("reply", { code: "P0002", message: "Alert is not linked to a client conversation" });
    expect(verdict).toMatchObject({ status: "ready", rpc: "ofoq_admin_reply_to_client", written: false });
    expect(verdict.args).toEqual(["p_alert_id", "p_body", "p_language"]);
    expect(verdict.detail.en).toContain("refused the probe id before writing");
  });

  it("reads PGRST202 and 42883 as «not exposed with these names» and names the fix", () => {
    for (const code of ["PGRST202", "42883"]) {
      const verdict = interpretActionProbe("reply", { code, message: "Could not find the function public.ofoq_admin_reply_to_client(...) in the schema cache" });
      expect(verdict.status).toBe("not_exposed");
      expect(verdict.hint).toContain("0007_admin_alerts.sql");
      expect(verdict.hint).toContain("NOTIFY pgrst, 'reload schema';");
      expect(verdict.hint).toContain("drop the older overload");
    }
    const resolve = interpretActionProbe("resolve", { code: "PGRST202", message: "Could not find the function … in the schema cache" });
    expect(resolve.status).toBe("not_exposed");
    expect(resolve.args).toEqual(["p_alert_id", "p_note"]);
  });

  it("separates a missing EXECUTE grant, a rejected payload and an impossible success", () => {
    expect(interpretActionProbe("reply", { code: "42501", message: "Staff access required" })).toMatchObject({ status: "permission_denied" });
    expect(interpretActionProbe("reply", { code: "42501", message: "permission denied for function" }).hint)
      .toContain("GRANT EXECUTE ON FUNCTION public.ofoq_admin_reply_to_client(text, text, text) TO authenticated;");
    expect(interpretActionProbe("reply", { code: "22023", message: "Reply must contain between 1 and 5000 characters" })).toMatchObject({ status: "rejected_input" });
    // A success for an id that cannot exist would mean the function stopped
    // verifying the alert it writes to — worth an explicit warning.
    expect(interpretActionProbe("reply", null)).toMatchObject({ status: "unexpected" });
    expect(interpretActionProbe("reply", null).detail.en).toContain("verify by hand that no row was written");
  });

  it("never reports a probe as a write", () => {
    for (const action of PROBED_ACTIONS) {
      for (const error of [null, { code: "P0002" }, { code: "PGRST202" }, { code: "42501" }, { code: "22023" }, { code: "42P01" }]) {
        expect(interpretActionProbe(action, error).written).toBe(false);
      }
    }
  });

  it("mirrors the composer's gate: replies need a conversation and a non-resolved alert", () => {
    expect(verdictForReplyability({ alert: { status: "NEW" }, conversation: { id: "conv-1" } })).toMatchObject({ replyable: true, reason: "ok" });
    expect(verdictForReplyability({ alert: { status: "ACKNOWLEDGED" }, conversation: { id: "conv-1" } })).toMatchObject({ replyable: true });
    expect(verdictForReplyability({ alert: { status: "NEW" }, conversation: null })).toMatchObject({ replyable: false, reason: "no_conversation" });
    expect(verdictForReplyability({ alert: { status: "RESOLVED" }, conversation: { id: "conv-1" } })).toMatchObject({ replyable: false, reason: "resolved" });
    expect(verdictForReplyability({})).toMatchObject({ replyable: false, reason: "unknown_alert" });
    expect(verdictForReplyability({ alert: { status: "RESOLVED" }, conversation: { id: "conv-1" } }).detail.ar).toContain("RESOLVED");
  });
});
