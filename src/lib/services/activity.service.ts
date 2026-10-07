import { logger } from "@/lib/core/logger";
import type { ActivityRow, Locale } from "@/lib/domain/types";
import { listActivities, recordActivity, type ActivityFilter } from "@/lib/repositories/governance.repo";

/**
 * Activity log.
 *
 * Every meaningful change in the platform lands here — including events that need
 * no human intervention, which are shown to staff as informational entries. The
 * helper never throws: a logging failure must not break the operation it records.
 */

export interface LogActivityInput {
  actor_type: ActivityRow["actor_type"];
  actor_user_id?: string | null;
  actor_label?: string | null;
  action: string;
  entity_type?: string | null;
  entity_id?: string | null;
  customer_id?: string | null;
  project_id?: string | null;
  summary_ar?: string | null;
  summary_en?: string | null;
  meta?: unknown;
  ip?: string | null;
  is_demo?: number;
}

export async function logActivity(input: LogActivityInput): Promise<ActivityRow | null> {
  try {
    return await recordActivity({
      actor_type: input.actor_type,
      actor_user_id: input.actor_user_id ?? null,
      actor_label: input.actor_label ?? null,
      action: input.action,
      entity_type: input.entity_type ?? null,
      entity_id: input.entity_id ?? null,
      customer_id: input.customer_id ?? null,
      project_id: input.project_id ?? null,
      summary_ar: input.summary_ar ?? null,
      summary_en: input.summary_en ?? null,
      meta: input.meta === undefined ? null : JSON.stringify(input.meta),
      ip: input.ip ?? null,
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

/** Compact bilingual summary used by the dashboard feed. */
export function activitySummary(row: ActivityRow, locale: Locale): string {
  const primary = locale === "ar" ? row.summary_ar : row.summary_en;
  const secondary = locale === "ar" ? row.summary_en : row.summary_ar;
  return primary?.trim() || secondary?.trim() || row.action;
}
