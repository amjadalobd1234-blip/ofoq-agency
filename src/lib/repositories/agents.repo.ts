import { getDb } from "@/lib/db";
import type { DbDriver } from "@/lib/db/types";
import type { AgentActionRow, AgentRow, AgentRunRow, RiskLevel } from "@/lib/domain/types";
import { nowIso } from "@/lib/core/date";

import { clean, findRowById, insertRow, updateRow } from "./base";

/* ------------------------------------------------------------------- agents */

export async function listAgents(db?: DbDriver): Promise<AgentRow[]> {
  const driver = db ?? (await getDb());
  return driver.query<AgentRow>("SELECT * FROM agents ORDER BY sort_order, key");
}

export async function findAgentByKey(key: string, db?: DbDriver): Promise<AgentRow | undefined> {
  const driver = db ?? (await getDb());
  return driver.get<AgentRow>("SELECT * FROM agents WHERE key = ?", [key]);
}

export async function upsertAgent(
  data: {
    key: string;
    name_ar: string;
    name_en: string;
    category: string;
    description_ar?: string | null;
    description_en?: string | null;
    is_enabled?: boolean;
    required_skills?: string | null;
    sort_order?: number;
    config?: unknown;
  },
  db?: DbDriver,
): Promise<AgentRow> {
  const driver = db ?? (await getDb());
  const existing = await findAgentByKey(data.key, driver);
  const timestamp = nowIso();
  if (existing) {
    return (await updateRow<AgentRow>(
      "agents",
      existing.id,
      {
        name_ar: data.name_ar,
        name_en: data.name_en,
        category: data.category,
        description_ar: data.description_ar ?? existing.description_ar,
        description_en: data.description_en ?? existing.description_en,
        required_skills: data.required_skills ?? existing.required_skills,
        sort_order: data.sort_order ?? existing.sort_order,
        is_enabled: data.is_enabled === undefined ? existing.is_enabled : data.is_enabled ? 1 : 0,
        config: data.config === undefined ? existing.config : JSON.stringify(data.config),
        updated_at: timestamp,
      },
      driver,
    ))!;
  }
  const row: AgentRow = {
    id: crypto.randomUUID(),
    key: data.key,
    name_ar: data.name_ar,
    name_en: data.name_en,
    category: data.category,
    description_ar: data.description_ar ?? null,
    description_en: data.description_en ?? null,
    is_enabled: data.is_enabled === false ? 0 : 1,
    required_skills: data.required_skills ?? null,
    sort_order: data.sort_order ?? 0,
    config: data.config === undefined ? null : JSON.stringify(data.config),
    updated_at: timestamp,
    created_at: timestamp,
  };
  await insertRow("agents", row, driver);
  return row;
}

export async function setAgentEnabled(key: string, enabled: boolean, db?: DbDriver): Promise<void> {
  const driver = db ?? (await getDb());
  await driver.run("UPDATE agents SET is_enabled = ?, updated_at = ? WHERE key = ?", [
    enabled ? 1 : 0,
    nowIso(),
    key,
  ]);
}

/* ----------------------------------------------------------------- agent run */

export async function startAgentRun(
  data: {
    agent_key: string;
    trigger: string;
    customer_id?: string | null;
    project_id?: string | null;
    conversation_id?: string | null;
    input?: unknown;
  },
  db?: DbDriver,
): Promise<string> {
  const id = crypto.randomUUID();
  await insertRow(
    "agent_runs",
    {
      id,
      agent_key: data.agent_key,
      trigger: data.trigger,
      customer_id: data.customer_id ?? null,
      project_id: data.project_id ?? null,
      conversation_id: data.conversation_id ?? null,
      status: "RUNNING",
      input: data.input === undefined ? null : JSON.stringify(data.input),
      created_at: nowIso(),
    },
    db,
  );
  return id;
}

export async function finishAgentRun(
  id: string,
  data: {
    status: AgentRunRow["status"];
    output?: unknown;
    provider?: string | null;
    model?: string | null;
    promptTokens?: number;
    completionTokens?: number;
    latencyMs?: number;
    error?: string | null;
  },
  db?: DbDriver,
): Promise<void> {
  const driver = db ?? (await getDb());
  await driver.run(
    `UPDATE agent_runs SET status = ?, output = ?, provider = ?, model = ?, prompt_tokens = ?,
       completion_tokens = ?, latency_ms = ?, error = ?, finished_at = ? WHERE id = ?`,
    [
      data.status,
      data.output === undefined ? null : JSON.stringify(data.output),
      data.provider ?? null,
      data.model ?? null,
      data.promptTokens ?? 0,
      data.completionTokens ?? 0,
      data.latencyMs ?? 0,
      data.error ?? null,
      nowIso(),
      id,
    ],
  );
}

export async function findAgentRun(id: string, db?: DbDriver): Promise<AgentRunRow | undefined> {
  return findRowById<AgentRunRow>("agent_runs", id, db);
}

export async function listAgentRuns(
  filter: { agentKey?: string; customerId?: string; limit?: number; offset?: number } = {},
  db?: DbDriver,
): Promise<{ rows: AgentRunRow[]; total: number }> {
  const driver = db ?? (await getDb());
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (filter.agentKey) {
    clauses.push("agent_key = ?");
    params.push(filter.agentKey);
  }
  if (filter.customerId) {
    clauses.push("customer_id = ?");
    params.push(filter.customerId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const totalRow = await driver.get<{ total: number }>(
    `SELECT COUNT(*) AS total FROM agent_runs ${where}`,
    params,
  );
  const rows = await driver.query<AgentRunRow>(
    `SELECT * FROM agent_runs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, filter.limit ?? 30, filter.offset ?? 0],
  );
  return { rows, total: Number(totalRow?.total ?? 0) };
}

/** Aggregated per-agent performance used by the control dashboard. */
export async function agentPerformance(
  sinceIso: string,
  db?: DbDriver,
): Promise<
  {
    agent_key: string;
    runs: number;
    failures: number;
    avg_latency_ms: number;
    last_run_at: string | null;
  }[]
> {
  const driver = db ?? (await getDb());
  const rows = await driver.query<{
    agent_key: string;
    runs: number;
    failures: number;
    avg_latency_ms: number | null;
    last_run_at: string | null;
  }>(
    `SELECT agent_key,
            COUNT(*) AS runs,
            SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) AS failures,
            AVG(latency_ms) AS avg_latency_ms,
            MAX(created_at) AS last_run_at
     FROM agent_runs WHERE created_at >= ? GROUP BY agent_key ORDER BY runs DESC`,
    [sinceIso],
  );
  return rows.map((row) => ({
    agent_key: row.agent_key,
    runs: Number(row.runs),
    failures: Number(row.failures ?? 0),
    avg_latency_ms: Number(row.avg_latency_ms ?? 0),
    last_run_at: row.last_run_at,
  }));
}

/* --------------------------------------------------------------- agent action */

export async function recordAgentAction(
  data: {
    agent_key: string;
    action: string;
    summary: string;
    agent_run_id?: string | null;
    entity_type?: string | null;
    entity_id?: string | null;
    customer_id?: string | null;
    reason?: string | null;
    risk_level?: RiskLevel;
    requires_approval?: boolean;
    payload?: unknown;
    is_demo?: number;
  },
  db?: DbDriver,
): Promise<AgentActionRow> {
  const row: AgentActionRow = {
    id: crypto.randomUUID(),
    agent_run_id: data.agent_run_id ?? null,
    agent_key: data.agent_key,
    action: data.action,
    entity_type: data.entity_type ?? null,
    entity_id: data.entity_id ?? null,
    customer_id: data.customer_id ?? null,
    summary: data.summary,
    reason: data.reason ?? null,
    risk_level: data.risk_level ?? "LOW",
    requires_approval: data.requires_approval ? 1 : 0,
    approved_by_user_id: null,
    approved_at: null,
    payload: data.payload === undefined ? null : JSON.stringify(data.payload),
    is_demo: data.is_demo ?? 0,
    created_at: nowIso(),
  };
  await insertRow("agent_actions", row, db);
  return row;
}

export async function approveAgentAction(
  id: string,
  userId: string,
  db?: DbDriver,
): Promise<AgentActionRow | undefined> {
  return updateRow<AgentActionRow>("agent_actions", id, {
    approved_by_user_id: userId,
    approved_at: nowIso(),
  }, db);
}

export async function listAgentActions(
  filter: {
    agentKey?: string;
    customerId?: string;
    pendingApproval?: boolean;
    limit?: number;
    offset?: number;
  } = {},
  db?: DbDriver,
): Promise<{ rows: AgentActionRow[]; total: number }> {
  const driver = db ?? (await getDb());
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (filter.agentKey) {
    clauses.push("agent_key = ?");
    params.push(filter.agentKey);
  }
  if (filter.customerId) {
    clauses.push("customer_id = ?");
    params.push(filter.customerId);
  }
  if (filter.pendingApproval) clauses.push("requires_approval = 1 AND approved_at IS NULL");
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const totalRow = await driver.get<{ total: number }>(
    `SELECT COUNT(*) AS total FROM agent_actions ${where}`,
    params,
  );
  const rows = await driver.query<AgentActionRow>(
    `SELECT * FROM agent_actions ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, filter.limit ?? 30, filter.offset ?? 0],
  );
  return { rows, total: Number(totalRow?.total ?? 0) };
}

export async function countPendingAgentActions(db?: DbDriver): Promise<number> {
  const driver = db ?? (await getDb());
  const row = await driver.get<{ total: number }>(
    "SELECT COUNT(*) AS total FROM agent_actions WHERE requires_approval = 1 AND approved_at IS NULL",
  );
  return Number(row?.total ?? 0);
}

export async function agentActionStats(
  sinceIso: string,
  db?: DbDriver,
): Promise<{ agent_key: string; actions: number; high_risk: number }[]> {
  const driver = db ?? (await getDb());
  const rows = await driver.query<{ agent_key: string; actions: number; high_risk: number | null }>(
    `SELECT agent_key, COUNT(*) AS actions,
            SUM(CASE WHEN risk_level = 'HIGH' THEN 1 ELSE 0 END) AS high_risk
     FROM agent_actions WHERE created_at >= ? GROUP BY agent_key ORDER BY actions DESC`,
    [sinceIso],
  );
  return rows.map((row) => ({
    agent_key: row.agent_key,
    actions: Number(row.actions),
    high_risk: Number(row.high_risk ?? 0),
  }));
}

export async function seedOrUpdateAgentRows(
  agents: {
    key: string;
    name_ar: string;
    name_en: string;
    category: string;
    description_ar?: string;
    description_en?: string;
    sort_order?: number;
  }[],
  db?: DbDriver,
): Promise<void> {
  for (const agent of agents) {
    await upsertAgent({ ...agent, is_enabled: true }, db);
  }
}

export async function cleanAgentData(kind: "runs" | "actions", db?: DbDriver): Promise<void> {
  const driver = db ?? (await getDb());
  if (kind === "runs") {
    await driver.exec("DELETE FROM agent_runs WHERE is_demo = 1");
    return;
  }
  await driver.exec("DELETE FROM agent_actions WHERE is_demo = 1");
}
