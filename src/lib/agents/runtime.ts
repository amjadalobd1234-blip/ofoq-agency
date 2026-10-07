import { aiStatus } from "@/lib/ai/provider";
import { logger } from "@/lib/core/logger";
import type { Locale, RiskLevel } from "@/lib/domain/types";
import { findAgentByKey, finishAgentRun, recordAgentAction, startAgentRun } from "@/lib/repositories/agents.repo";

import { agentDefinition, agentLabel, type AgentKey } from "./registry";

/**
 * Agent runtime.
 *
 * Every agent invocation goes through `runAgent`, which guarantees that:
 *   1. disabled agents are skipped (never silently executed),
 *   2. a run row is written (input, output, provider/model, latency, errors),
 *   3. each decision is recorded as an `agent_action` with a risk level and an
 *      explicit "requires approval" flag,
 *   4. failures produce a human-visible alert instead of an invisible error,
 *   5. the whole event lands in the activity log.
 *
 * This is the mechanism that makes the "AI agents run the agency" story
 * auditable rather than decorative.
 */
export interface AgentRunContext {
  trigger: string;
  locale: Locale;
  customerId?: string | null;
  projectId?: string | null;
  conversationId?: string | null;
  actorUserId?: string | null;
  input?: unknown;
  /** Bypasses the enabled check — used by setup/migration tasks only. */
  force?: boolean;
}

export interface RecordedAction {
  action: string;
  summary: string;
  reason?: string;
  riskLevel?: RiskLevel;
  requiresApproval?: boolean;
  entityType?: string | null;
  entityId?: string | null;
  /** Defaults to the conversation's customer when omitted. */
  customerId?: string | null;
  payload?: unknown;
}

export interface AgentRunOutcome<T> {
  data: T;
  runId: string;
  summary: string;
  actions: RecordedAction[];
  skipped: boolean;
}

export interface AgentHandlerResult<T> {
  data: T;
  /** One-line description of what the agent did (shown in dashboards). */
  summary: string;
  actions?: RecordedAction[];
  riskLevel?: RiskLevel;
}

export class AgentDisabledError extends Error {
  constructor(public readonly agentKey: AgentKey) {
    super(`Agent "${agentKey}" is disabled in the agent configuration.`);
    this.name = "AgentDisabledError";
  }
}

export async function isAgentEnabled(key: AgentKey): Promise<boolean> {
  const row = await findAgentByKey(key);
  // Unknown agents default to enabled so a fresh database still works before
  // seeding; the registry remains the source of truth for definitions.
  if (!row) return true;
  return row.is_enabled === 1;
}

export async function runAgent<T>(
  key: AgentKey,
  context: AgentRunContext,
  handler: (api: {
    record: (action: RecordedAction) => void;
    locale: Locale;
    aiAvailable: boolean;
  }) => Promise<AgentHandlerResult<T>>,
): Promise<AgentRunOutcome<T>> {
  const definition = agentDefinition(key);
  const enabled = context.force || (await isAgentEnabled(key));
  if (!enabled) {
    throw new AgentDisabledError(key);
  }

  const status = aiStatus();
  const runId = await startAgentRun({
    agent_key: key,
    trigger: context.trigger,
    customer_id: context.customerId ?? null,
    project_id: context.projectId ?? null,
    conversation_id: context.conversationId ?? null,
    input: context.input,
  });

  const actions: RecordedAction[] = [];
  const started = Date.now();

  try {
    const result = await handler({
      record: (action) => actions.push(action),
      locale: context.locale,
      aiAvailable: status.available,
    });

    await finishAgentRun(runId, {
      status: "SUCCEEDED",
      output: result.data,
      provider: status.provider,
      model: status.model,
      latencyMs: Date.now() - started,
    });

    for (const action of actions) {
      await recordAgentAction({
        agent_run_id: runId,
        agent_key: key,
        action: action.action,
        summary: action.summary,
        reason: action.reason ?? null,
        risk_level: action.riskLevel ?? definition.defaultRisk,
        requires_approval: action.requiresApproval ?? false,
        entity_type: action.entityType ?? null,
        entity_id: action.entityId ?? null,
        customer_id: action.customerId ?? context.customerId ?? null,
        payload: action.payload,
      });
    }

    await logAgentActivity(
      "agent.run.succeeded",
      `[${agentLabel(key, context.locale)}] ${result.summary}`,
      context,
      { actions: actions.length, runId },
    );

    return { data: result.data, runId, summary: result.summary, actions, skipped: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishAgentRun(runId, { status: "FAILED", error: message, latencyMs: Date.now() - started });
    logger.error("Agent run failed", { agent: key, error: message, customerId: context.customerId });

    await logAgentActivity("agent.run.failed", `[${agentLabel(key, context.locale)}] ${message}`, context, {
      runId,
    });

    try {
      const { raiseAlert } = await import("@/lib/services/alerts.service");
      await raiseAlert({
        severity: "IMPORTANT",
        category: "agents",
        title_ar: `تعذّر تشغيل وكيل: ${definition.nameAr}`,
        title_en: `Agent run failed: ${definition.nameEn}`,
        body_ar: `الوكيل ${definition.nameAr} لم يكمل مهمته. السبب: ${message}`,
        body_en: `The ${definition.nameEn} agent did not complete its task. Reason: ${message}`,
        entity_type: "agent_run",
        entity_id: runId,
        customer_id: context.customerId ?? null,
        dedupe_key: `agent-failure:${key}:${new Date().toISOString().slice(0, 13)}`,
        meta: { agentKey: key },
      });
    } catch (alertError) {
      logger.warn("Could not raise agent-failure alert", { error: alertError });
    }

    throw error;
  }
}

/**
 * Records an action that an agent proposed but a human must approve first.
 * Nothing is applied to the database until `approveAndApply` runs.
 */
export async function proposeAction(
  key: AgentKey,
  context: AgentRunContext,
  action: RecordedAction,
): Promise<string> {
  const row = await recordAgentAction({
    agent_key: key,
    action: action.action,
    summary: action.summary,
    reason: action.reason ?? null,
    risk_level: action.riskLevel ?? "MEDIUM",
    requires_approval: true,
    entity_type: action.entityType ?? null,
    entity_id: action.entityId ?? null,
    customer_id: context.customerId ?? null,
    payload: action.payload,
  });
  return row.id;
}

async function logAgentActivity(
  action: string,
  summary: string,
  context: AgentRunContext,
  meta?: Record<string, unknown>,
): Promise<void> {
  const { logActivity } = await import("@/lib/services/activity.service");
  await logActivity({
    actor_type: "AGENT",
    actor_label: context.trigger,
    action,
    entity_type: "agent",
    entity_id: context.customerId ?? context.projectId ?? null,
    customer_id: context.customerId ?? null,
    summary,
    meta,
  });
}

/**
 * Runs a handler with the agent disabled → returns `null` instead of throwing.
 * Used on the request path (chat) where a disabled agent must degrade gracefully.
 */
export async function runAgentSafe<T>(
  key: AgentKey,
  context: AgentRunContext,
  handler: Parameters<typeof runAgent<T>>[2],
): Promise<AgentRunOutcome<T> | null> {
  if (!(await isAgentEnabled(key))) return null;
  try {
    return await runAgent(key, context, handler);
  } catch (error) {
    if (error instanceof AgentDisabledError) return null;
    throw error;
  }
}
