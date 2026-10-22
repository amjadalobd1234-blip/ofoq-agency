-- Project plans (وكيل إدارة المشاريع) — the plan a project runs on.
--
-- A plan is a versioned, reviewable document: phases (المراحل), their tasks
-- (المهام), deadlines (المواعيد) and responsibilities (المسؤوليات). It moves
-- DRAFT → AWAITING_APPROVAL → APPROVED, and only an explicit owner decision
-- (recorded in `approved_by_user_id` / `approved_at`) can approve it.
--
-- The plan reuses the existing `projects` and `project_tasks` tables: a task
-- belongs to a plan through `project_tasks.phase_key`, and the plan row holds
-- the phase structure. `project_tasks.internal_note` stores notes that must
-- never reach the client (unlike `description`, which belongs to the
-- client-visible task itself).
--
-- Supabase additionally applies the RLS/privilege hardening and the client-safe
-- portal RPC in db/migrations/supabase/0011_project_plans.sql.

CREATE TABLE project_plans (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  version             INTEGER NOT NULL DEFAULT 1,
  status              TEXT NOT NULL CHECK (status IN ('DRAFT', 'AWAITING_APPROVAL', 'APPROVED', 'SUPERSEDED')),
  locale              TEXT NOT NULL DEFAULT 'ar',
  summary             TEXT,
  phases              TEXT NOT NULL DEFAULT '[]',
  start_date          TEXT,
  due_date            TEXT,
  created_by_user_id  TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_by_agent    TEXT,
  approved_by_user_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  approved_at         TEXT,
  review_note         TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_project_plans_project_version ON project_plans (project_id, version);
CREATE INDEX idx_project_plans_project ON project_plans (project_id, status);

ALTER TABLE project_tasks ADD COLUMN internal_note TEXT;
ALTER TABLE project_tasks ADD COLUMN phase_key TEXT;

CREATE INDEX idx_project_tasks_phase ON project_tasks (project_id, phase_key);
