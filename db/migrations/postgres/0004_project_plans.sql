-- GENERATED FILE — do not edit by hand.
-- Source of truth: db/migrations/sqlite/*.sql
-- Regenerate with: npm run db:generate-postgres
-- Generated from 0004_project_plans.sql.

CREATE TABLE project_plans (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  version             BIGINT NOT NULL DEFAULT 1,
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

ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS internal_note TEXT;

ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS phase_key TEXT;

CREATE INDEX idx_project_tasks_phase ON project_tasks (project_id, phase_key);
