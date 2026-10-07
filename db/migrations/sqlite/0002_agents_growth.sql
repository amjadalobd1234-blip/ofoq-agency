-- =============================================================================
--  Ofoq platform — agents, automation, growth & messaging (migration 0002)
-- -----------------------------------------------------------------------------
--  Portable SQL subset, same conventions as 0001_core.sql.
-- =============================================================================

-- ------------------------------------------------------------------ agents ---

CREATE TABLE agents (
  id              TEXT PRIMARY KEY,
  key             TEXT NOT NULL UNIQUE,
  name_ar         TEXT NOT NULL,
  name_en         TEXT NOT NULL,
  category        TEXT NOT NULL,
  description_ar  TEXT,
  description_en  TEXT,
  is_enabled      INTEGER NOT NULL DEFAULT 1,
  required_skills TEXT,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  config          TEXT,
  updated_at      TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE TABLE agent_runs (
  id                TEXT PRIMARY KEY,
  agent_key         TEXT NOT NULL,
  trigger           TEXT NOT NULL,
  customer_id       TEXT REFERENCES customers (id) ON DELETE SET NULL,
  project_id        TEXT REFERENCES projects (id) ON DELETE SET NULL,
  conversation_id   TEXT REFERENCES conversations (id) ON DELETE SET NULL,
  status            TEXT NOT NULL CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED', 'AWAITING_APPROVAL')),
  input             TEXT,
  output            TEXT,
  provider          TEXT,
  model             TEXT,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms        INTEGER NOT NULL DEFAULT 0,
  error             TEXT,
  is_demo           INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  finished_at       TEXT
);

CREATE INDEX idx_agent_runs_agent ON agent_runs (agent_key, created_at);
CREATE INDEX idx_agent_runs_customer ON agent_runs (customer_id, created_at);

-- Every decision an agent makes, with its risk level and whether a human had to
-- approve it. This is the audit trail required by the platform rules.
CREATE TABLE agent_actions (
  id                  TEXT PRIMARY KEY,
  agent_run_id        TEXT REFERENCES agent_runs (id) ON DELETE SET NULL,
  agent_key           TEXT NOT NULL,
  action              TEXT NOT NULL,
  entity_type         TEXT,
  entity_id           TEXT,
  customer_id         TEXT REFERENCES customers (id) ON DELETE SET NULL,
  summary             TEXT NOT NULL,
  reason              TEXT,
  risk_level          TEXT NOT NULL DEFAULT 'LOW' CHECK (risk_level IN ('LOW', 'MEDIUM', 'HIGH')),
  requires_approval   INTEGER NOT NULL DEFAULT 0,
  approved_by_user_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  approved_at         TEXT,
  payload             TEXT,
  is_demo             INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL
);

CREATE INDEX idx_agent_actions_created ON agent_actions (created_at);
CREATE INDEX idx_agent_actions_pending ON agent_actions (requires_approval, approved_at);

-- --------------------------------------------------------------- campaigns ---

CREATE TABLE campaigns (
  id                  TEXT PRIMARY KEY,
  customer_id         TEXT NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  project_id          TEXT REFERENCES projects (id) ON DELETE SET NULL,
  platform            TEXT NOT NULL CHECK (platform IN ('GOOGLE_ADS', 'META_ADS', 'TIKTOK', 'SNAPCHAT', 'X_ADS', 'LINKEDIN', 'OTHER')),
  external_id         TEXT,
  name                TEXT NOT NULL,
  objective           TEXT,
  status              TEXT NOT NULL CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED')),
  currency            TEXT NOT NULL DEFAULT 'USD',
  total_budget_minor  INTEGER NOT NULL DEFAULT 0,
  daily_budget_minor  INTEGER NOT NULL DEFAULT 0,
  monthly_budget_minor INTEGER NOT NULL DEFAULT 0,
  spent_minor         INTEGER NOT NULL DEFAULT 0,
  start_date          TEXT,
  end_date            TEXT,
  targeting           TEXT,
  keywords            TEXT,
  ad_copy             TEXT,
  autopilot_enabled   INTEGER NOT NULL DEFAULT 0,
  safe_limits         TEXT,
  sync_status         TEXT NOT NULL DEFAULT 'DISABLED' CHECK (sync_status IN ('DISABLED', 'NOT_CONNECTED', 'SYNCED', 'ERROR')),
  last_sync_at        TEXT,
  created_by_agent    TEXT,
  created_by_user_id  TEXT REFERENCES users (id) ON DELETE SET NULL,
  is_demo             INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE INDEX idx_campaigns_customer ON campaigns (customer_id, status);
CREATE INDEX idx_campaigns_platform ON campaigns (platform, status);

CREATE TABLE campaign_metrics_daily (
  id                   TEXT PRIMARY KEY,
  campaign_id          TEXT NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
  metric_date          TEXT NOT NULL,
  impressions          INTEGER NOT NULL DEFAULT 0,
  clicks               INTEGER NOT NULL DEFAULT 0,
  cost_minor           INTEGER NOT NULL DEFAULT 0,
  conversions          REAL NOT NULL DEFAULT 0,
  conversion_value_minor INTEGER NOT NULL DEFAULT 0,
  ctr                  REAL,
  cpc_minor            INTEGER,
  cpa_minor            INTEGER,
  source               TEXT NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL', 'API', 'IMPORT')),
  raw                  TEXT,
  created_at           TEXT NOT NULL,
  UNIQUE (campaign_id, metric_date)
);

CREATE INDEX idx_metrics_campaign_date ON campaign_metrics_daily (campaign_id, metric_date);

CREATE TABLE campaign_changes (
  id              TEXT PRIMARY KEY,
  campaign_id     TEXT NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
  agent_key       TEXT,
  change_type     TEXT NOT NULL,
  before_state    TEXT,
  after_state     TEXT,
  reason          TEXT,
  risk_level      TEXT NOT NULL DEFAULT 'LOW' CHECK (risk_level IN ('LOW', 'MEDIUM', 'HIGH')),
  auto_applied    INTEGER NOT NULL DEFAULT 0,
  within_limits   INTEGER NOT NULL DEFAULT 1,
  approver_user_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  applied_at      TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX idx_campaign_changes_campaign ON campaign_changes (campaign_id, created_at);

-- ---------------------------------------------------------------- reports ---

CREATE TABLE reports (
  id                TEXT PRIMARY KEY,
  customer_id       TEXT NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  project_id        TEXT REFERENCES projects (id) ON DELETE SET NULL,
  campaign_id       TEXT REFERENCES campaigns (id) ON DELETE SET NULL,
  report_type       TEXT NOT NULL CHECK (report_type IN ('CAMPAIGN_DAILY', 'CAMPAIGN_DEEP', 'PROJECT', 'MONTHLY_SUMMARY', 'SERVICE')),
  language          TEXT NOT NULL DEFAULT 'ar',
  period_start      TEXT,
  period_end        TEXT,
  title             TEXT NOT NULL,
  summary           TEXT NOT NULL,
  body              TEXT,
  metrics           TEXT,
  status            TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'SENT', 'FAILED')),
  channel           TEXT DEFAULT 'PORTAL',
  generated_by_agent TEXT,
  sent_at           TEXT,
  is_demo           INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL
);

CREATE INDEX idx_reports_customer ON reports (customer_id, created_at);
CREATE INDEX idx_reports_type ON reports (report_type, created_at);

-- ------------------------------------------------------- alerts & messages ---

CREATE TABLE alerts (
  id                    TEXT PRIMARY KEY,
  severity              TEXT NOT NULL CHECK (severity IN ('URGENT', 'IMPORTANT', 'INFO')),
  category              TEXT NOT NULL,
  title_ar              TEXT NOT NULL,
  title_en              TEXT NOT NULL,
  body_ar               TEXT,
  body_en               TEXT,
  entity_type           TEXT,
  entity_id             TEXT,
  customer_id           TEXT REFERENCES customers (id) ON DELETE SET NULL,
  target_role           TEXT NOT NULL DEFAULT 'ANY_STAFF' CHECK (target_role IN ('OWNER', 'PARTNER', 'ANY_STAFF', 'CLIENT')),
  status                TEXT NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW', 'ACKNOWLEDGED', 'RESOLVED')),
  acknowledged_by_user_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  acknowledged_at       TEXT,
  resolved_at           TEXT,
  dedupe_key            TEXT UNIQUE,
  meta                  TEXT,
  is_demo               INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE INDEX idx_alerts_status ON alerts (status, severity, created_at);

CREATE TABLE notifications (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  alert_id    TEXT REFERENCES alerts (id) ON DELETE SET NULL,
  channel     TEXT NOT NULL CHECK (channel IN ('IN_APP', 'EMAIL', 'WHATSAPP')),
  subject     TEXT,
  body        TEXT,
  status      TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED', 'SENT', 'FAILED', 'READ')),
  error       TEXT,
  sent_at     TEXT,
  read_at     TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX idx_notifications_user ON notifications (user_id, status, created_at);

CREATE TABLE outbox_emails (
  id          TEXT PRIMARY KEY,
  to_email    TEXT NOT NULL,
  to_user_id  TEXT REFERENCES users (id) ON DELETE SET NULL,
  subject     TEXT NOT NULL,
  text        TEXT,
  html        TEXT,
  template    TEXT,
  status      TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED', 'SENT', 'FAILED')),
  provider    TEXT NOT NULL DEFAULT 'console',
  attempts    INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  meta        TEXT,
  sent_at     TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX idx_outbox_status ON outbox_emails (status, created_at);

CREATE TABLE webhook_events (
  id              TEXT PRIMARY KEY,
  provider        TEXT NOT NULL,
  event_type      TEXT,
  external_id     TEXT,
  signature_valid INTEGER NOT NULL DEFAULT 0,
  payload         TEXT,
  status          TEXT NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED')),
  error           TEXT,
  processed_at    TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX idx_webhook_provider ON webhook_events (provider, created_at);

CREATE TABLE integration_connections (
  id               TEXT PRIMARY KEY,
  provider         TEXT NOT NULL UNIQUE,
  status           TEXT NOT NULL DEFAULT 'DISABLED' CHECK (status IN ('DISABLED', 'DISCONNECTED', 'CONNECTED', 'ERROR')),
  account_label    TEXT,
  account_ref      TEXT,
  scopes           TEXT,
  access_token_enc TEXT,
  refresh_token_enc TEXT,
  token_expires_at TEXT,
  last_error       TEXT,
  meta             TEXT,
  last_checked_at  TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE TABLE job_runs (
  id              TEXT PRIMARY KEY,
  job_key         TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED')),
  started_at      TEXT NOT NULL,
  finished_at     TEXT,
  items_processed INTEGER NOT NULL DEFAULT 0,
  summary         TEXT,
  error           TEXT,
  meta            TEXT
);

CREATE INDEX idx_job_runs_key ON job_runs (job_key, started_at);
