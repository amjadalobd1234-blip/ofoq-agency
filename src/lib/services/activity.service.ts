import { logger } from "@/lib/core/logger";
import type { ActivityRow, Locale } from "@/lib/domain/types";
import { listActivities, recordActivity, type ActivityFilter } from "@/lib/repositories/governance.repo";

/**
 * Activity log.
 *
 * Every meaningful change in the platform lands here — including events that need
 * no human intervention, which are shown to staff as informational entries. The
 * helper never throws: a logging failure must not break the operation it records.
 *
 * The stored row keeps one `summary` plus free-form `meta`, matching the schema.
 * Bilingual callers may pass `summary_ar` / `summary_en`; the Arabic form is used
 * as the headline and both are preserved inside `meta`.
 */

export interface LogActivityInput {
  actor_type: ActivityRow["actor_type"];
  actor_user_id?: string | null;
  actor_label?: string | null;
  action: string;
  entity_type?: string | null;
  entity_id?: string | null;
  customer_id?: string | null;
  /** Optional: folded into the entity reference so project history stays readable. */
  project_id?: string | null;
  summary: string;
  summary_ar?: string | null;
  summary_en?: string | null;
  meta?: unknown;
  ip?: string | null;
  user_agent?: string | null;
  is_demo?: number;
}

export async function logActivity(input: LogActivityInput): Promise<ActivityRow | null> {
  try {
    const headline = input.summary_ar?.trim() || input.summary?.trim() || input.summary_en?.trim() || input.action;
    const entityType = input.entity_type ?? (input.project_id ? "project" : null);
    const entityId = input.entity_id ?? input.project_id ?? null;

    const meta: Record<string, unknown> = {};
    if (input.meta && typeof input.meta === "object") Object.assign(meta, input.meta as Record<string, unknown>);
    if (input.summary_en && input.summary_en !== headline) meta.summaryEn = input.summary_en;
    if (input.summary_ar && input.summary_ar !== headline) meta.summaryAr = input.summary_ar;
    if (input.project_id) meta.projectId = input.project_id;

    return await recordActivity({
      actor_type: input.actor_type,
      action: input.action,
      actor_user_id: input.actor_user_id ?? null,
      actor_label: input.actor_label ?? null,
      entity_type: entityType,
      entity_id: entityId,
      customer_id: input.customer_id ?? null,
      summary: headline,
      meta: Object.keys(meta).length > 0 ? meta : null,
      ip: input.ip ?? null,
      user_agent: input.user_agent ?? null,
      is_demo: input.is_demo ?? 0,
    });
  } catch (error) {
    logger.error("Failed to write activity log", { error, action: input.action });
    return null;
  }
}

export async function listActivityLog(
  filter: ActivityFilter = {},
): Promise<{ rows: ActivityRow[]; total: number }> {
  return listActivities(filter);
}

export function activitySummary(row: ActivityRow, _locale: Locale = "ar"): string {
  return row.summary?.trim() || row.action.replace(/[._]/g, " ");
}
