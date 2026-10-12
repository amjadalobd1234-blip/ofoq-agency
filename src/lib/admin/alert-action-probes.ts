/**
 * «Is the database really callable with the argument names the button sends?»
 *
 * Answered by PROBING, not by guessing. `GET /api/debug/alerts` calls each write
 * action with an alert id that cannot exist — the nil UUID — and reads the
 * answer:
 *
 *   P0002  the function ran, matched the argument names, looked for the alert,
 *          found none and refused BEFORE writing anything → the button is wired
 *          correctly, so a failure in the page is about that specific alert
 *          (usually: it is not linked to a conversation, or already resolved).
 *   PGRST202 / 42883
 *          PostgREST cannot resolve the function with these parameter names —
 *          the migration is missing, or an older overload with different names
 *          is installed. This is the single most common cause of «the button
 *          does nothing».
 *   42501  the function exists but the caller may not EXECUTE it (grant missing,
 *          or the account is not staff).
 *   22023  the function ran and rejected the payload — the signature is fine.
 *
 * The probe is write-free by construction: the alert lookup happens before the
 * message insert in both actions, and the nil id matches no row. The result is
 * reported next to the RPC's expected argument list, so a mismatch is readable
 * as a diff instead of a stack trace.
 */
import { ALERT_ACTION_RPC, type AlertAction } from "./alert-route-guard";
import type { PostgrestErrorLike } from "@/lib/supabase/route-auth";

/** A UUID that cannot be an alert id, so the RPC refuses before writing. */
export const ACTION_PROBE_ALERT_ID = "00000000-0000-0000-0000-000000000000";

/** The actions that can be probed on a live project. Both are write-free. */
export const PROBED_ACTIONS = ["reply", "resolve"] as const;
export type ProbedAction = (typeof PROBED_ACTIONS)[number];

export type ActionProbeStatus = "ready" | "not_exposed" | "permission_denied" | "rejected_input" | "unexpected";

export interface ActionProbeVerdict {
  action: ProbedAction;
  rpc: string;
  /** Argument names the app sends — the PostgREST resolution contract. */
  args: readonly string[];
  /** The probe alert id used; it matches no row, so nothing can be written. */
  probeAlertId: string;
  status: ActionProbeStatus;
  /** What the Data API answered, verbatim. */
  error: PostgrestErrorLike | null;
  written: false;
  detail: { ar: string; en: string };
  hint: string;
}

/** The arguments each probe sends — identical names to the real buttons. */
export function probeArguments(action: ProbedAction, probeAlertId: string): Record<string, unknown> {
  return action === "reply"
    ? { p_alert_id: probeAlertId, p_body: "[diagnostic probe — not a client reply]", p_language: "ar" }
    : { p_alert_id: probeAlertId, p_note: null };
}

/** Turns one probe response into a verdict the page can print. */
export function interpretActionProbe(action: ProbedAction, error: PostgrestErrorLike | null): ActionProbeVerdict {
  const { rpc, args } = ALERT_ACTION_RPC[action as AlertAction];
  const base = {
    action,
    rpc,
    args,
    probeAlertId: ACTION_PROBE_ALERT_ID,
    error,
    written: false as const,
  };
  const signature = `${rpc}(${args.join(", ")})`;
  const code = error?.code ?? null;
  const message = error?.message ?? "";

  if (error === null) {
    return {
      ...base,
      status: "unexpected",
      detail: {
        ar: `أجاب ${signature} بلا خطأ لمعرّف تنبيه غير موجود — تحقق يدويًا من عدم كتابة أي صف.`,
        en: `${signature} answered without an error for an alert id that cannot exist — verify by hand that no row was written.`,
      },
      hint: "Unexpected: the probe should have been refused with P0002. Check the function body in the SQL Editor.",
    };
  }

  if (code === "P0002") {
    return {
      ...base,
      status: "ready",
      detail: {
        ar: `متاحة بالأسماء الصحيحة: ${signature} وصلت إلى جسم الدالة ورفضت المعرّف التجريبي قبل أي كتابة (${message || "Alert not found"}).`,
        en: `${signature} is resolvable and ran: it refused the probe id before writing (${message || "Alert not found"}).`,
      },
      hint: "Nothing to fix on this RPC. If the page still cannot send, open the alert and check its status/conversation below.",
    };
  }

  if (code === "22023") {
    return {
      ...base,
      status: "rejected_input",
      detail: {
        ar: `الأسماء صحيحة (${signature}) لكن الدالة رفضت قيمة الوسيط — الأرجح أن الـ probe لا يطابق شرطًا في الدالة.`,
        en: `The argument names resolve (${signature}) but the function rejected a value — the probe payload does not satisfy a check inside it.`,
      },
      hint: `Re-run the probe with a valid payload, or check the guards at the top of ${rpc}.`,
    };
  }

  if (code === "PGRST202" || code === "42883" || /does not exist|could not find the function/i.test(message)) {
    return {
      ...base,
      status: "not_exposed",
      detail: {
        ar: `غير متاحة عبر الـ API بالأسماء المتوقعة: (${args.join(", ")}). هذا هو سبب عدم استجابة الزر.`,
        en: `Not exposed through the Data API with the expected names (${args.join(", ")}). This is why the button does not respond.`,
      },
      hint: `Apply db/migrations/supabase/0007_admin_alerts.sql (or section 3 of docs/setup/supabase-setup.sql), then run: NOTIFY pgrst, 'reload schema'; — or drop the older overload of ${rpc} first if it was installed with different parameter names.`,
    };
  }

  if (code === "42501") {
    return {
      ...base,
      status: "permission_denied",
      detail: {
        ar: `موجودة لكن التنفيذ ممنوع على هذه الجلسة (${message || "permission denied"}).`,
        en: `Present but not executable by this session (${message || "permission denied"}).`,
      },
      hint: `Re-run the GRANT EXECUTE ON FUNCTION public.${rpc}(${args.map(() => "text").join(", ")}) TO authenticated; block of the migration.`,
    };
  }

  return {
    ...base,
    status: "unexpected",
    detail: {
      ar: `ردّ غير متوقع من الـ API: ${code ?? "بلا رمز"} — ${message || "بلا رسالة"}.`,
      en: `Unexpected Data API answer: ${code ?? "no code"} — ${message || "no message"}.`,
    },
    hint: `Nothing was written (the probe id matches no alert). Compare pg_get_function_arguments for ${rpc} with (${args.join(", ")}).`,
  };
}

/** Why the send button may be disabled, in the page's own terms. */
export type ReplyabilityReason = "ok" | "no_conversation" | "resolved" | "unknown_alert";

export interface ReplyabilityVerdict {
  replyable: boolean;
  reason: ReplyabilityReason;
  detail: { ar: string; en: string };
}

/**
 * The client-side gate, mirrored on the server so the diagnostics report says
 * the same thing the disabled button does:
 *
 *   canReply = Boolean(details.conversation) && alert.status !== "RESOLVED"
 */
export function verdictForReplyability(details: unknown): ReplyabilityVerdict {
  const record = typeof details === "object" && details !== null ? (details as Record<string, unknown>) : {};
  const alert = typeof record.alert === "object" && record.alert !== null ? (record.alert as Record<string, unknown>) : null;
  const conversation = typeof record.conversation === "object" && record.conversation !== null ? record.conversation : null;
  if (!alert) {
    return {
      replyable: false,
      reason: "unknown_alert",
      detail: {
        ar: "لم تُرجع الدالة تفاصيل التنبيه، فلا يمكن الحكم على قابلية الرد.",
        en: "The details RPC returned no alert, so replyability cannot be decided.",
      },
    };
  }
  if (!conversation) {
    return {
      replyable: false,
      reason: "no_conversation",
      detail: {
        ar: "هذا التنبيه غير مرتبط بمحادثة عميل (entity_type/entity_id)، ولذلك يظهر زر الإرسال معطّلًا.",
        en: "This alert is not linked to a client conversation (entity_type/entity_id), which disables the send button.",
      },
    };
  }
  if (alert.status === "RESOLVED") {
    return {
      replyable: false,
      reason: "resolved",
      detail: {
        ar: "التنبيه مُغلق (RESOLVED)، ولذلك يظهر زر الإرسال معطّلًا حتى يصل تصعيد جديد.",
        en: "The alert is RESOLVED, which disables the send button until a new escalation arrives.",
      },
    };
  }
  return {
    replyable: true,
    reason: "ok",
    detail: {
      ar: "التنبيه مرتبط بمحادثة مفتوحة للرد.",
      en: "The alert is linked to a conversation that can receive a reply.",
    },
  };
}
