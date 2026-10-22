-- GENERATED FILE — do not edit by hand.
-- Source of truth: db/migrations/sqlite/*.sql
-- Regenerate with: npm run db:generate-postgres
-- Generated from 0005_ad_plans.sql.

CREATE TABLE ad_plans (
  id                  TEXT PRIMARY KEY,
  code                TEXT NOT NULL,
  customer_id         TEXT NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  project_id          TEXT REFERENCES projects (id) ON DELETE SET NULL,
  family_key          TEXT NOT NULL,
  version             BIGINT NOT NULL DEFAULT 1,
  status              TEXT NOT NULL CHECK (status IN ('DRAFT', 'AWAITING_APPROVAL', 'APPROVED', 'SUPERSEDED')),
  locale              TEXT NOT NULL DEFAULT 'ar',
  currency            TEXT NOT NULL DEFAULT 'USD',
  summary             TEXT,
  body                TEXT NOT NULL DEFAULT '{}',
  forecasts           TEXT,
  internal_note       TEXT,
  review_note         TEXT,
  created_by_user_id  TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_by_agent    TEXT,
  approved_by_user_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  approved_at         TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE TABLE ad_plan_results (
  id                  TEXT PRIMARY KEY,
  ad_plan_id          TEXT NOT NULL REFERENCES ad_plans (id) ON DELETE CASCADE,
  customer_id         TEXT NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  result_date         TEXT NOT NULL,
  platform            TEXT NOT NULL DEFAULT 'ALL' CHECK (platform IN ('META_ADS', 'GOOGLE_ADS', 'TIKTOK', 'ALL')),
  spend_minor         BIGINT NOT NULL DEFAULT 0,
  impressions         BIGINT NOT NULL DEFAULT 0,
  clicks              BIGINT NOT NULL DEFAULT 0,
  messages            BIGINT NOT NULL DEFAULT 0,
  orders              BIGINT NOT NULL DEFAULT 0,
  source              TEXT NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL')),
  notes               TEXT,
  created_by_user_id  TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL,
  UNIQUE (ad_plan_id, result_date, platform)
);

CREATE UNIQUE INDEX idx_ad_plans_family_version ON ad_plans (family_key, version);

CREATE INDEX idx_ad_plans_code ON ad_plans (code);

CREATE INDEX idx_ad_plans_customer ON ad_plans (customer_id, status, created_at);

CREATE INDEX idx_ad_plans_project ON ad_plans (project_id, status);

CREATE INDEX idx_ad_plan_results_plan ON ad_plan_results (ad_plan_id, result_date);

CREATE INDEX idx_ad_plan_results_customer ON ad_plan_results (customer_id, result_date);

ALTER TABLE reports ADD COLUMN IF NOT EXISTS ad_plan_id TEXT;

CREATE INDEX idx_reports_ad_plan ON reports (ad_plan_id, created_at);
