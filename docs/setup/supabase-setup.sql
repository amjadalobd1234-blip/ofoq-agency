-- Ofoq / Supabase PostgreSQL setup
-- Generated from db/migrations/sqlite/*.sql. Do not edit by hand.
-- Regenerate with: npm run db:generate-postgres
-- Creates 35 application tables plus the _migrations tracking table (36 total).
-- Safe to re-run: existing tables and indexes are left unchanged.
-- Run this as the Supabase database owner (normally `postgres`).

CREATE SCHEMA IF NOT EXISTS public;

SET search_path TO public;

CREATE TABLE IF NOT EXISTS public._migrations (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  checksum     TEXT NOT NULL,
  applied_at   TEXT NOT NULL,
  duration_ms  BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS public.users (
  id                 TEXT PRIMARY KEY,
  email              TEXT NOT NULL UNIQUE,
  password_hash      TEXT,
  name               TEXT NOT NULL,
  role               TEXT NOT NULL CHECK (role IN ('OWNER', 'PARTNER', 'CLIENT')),
  status             TEXT NOT NULL CHECK (status IN ('ACTIVE', 'PENDING', 'SUSPENDED', 'DELETED')),
  locale             TEXT NOT NULL DEFAULT 'ar',
  phone              TEXT,
  country            TEXT,
  avatar_url         TEXT,
  google_sub         TEXT UNIQUE,
  email_verified_at  TEXT,
  last_login_at      TEXT,
  is_demo            BIGINT NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public.sessions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,
  user_agent    TEXT,
  ip            TEXT,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  revoked_at    TEXT
);

CREATE TABLE IF NOT EXISTS public.verification_tokens (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK (type IN ('EMAIL_VERIFY', 'PASSWORD_RESET')),
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  meta        TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public.login_attempts (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  ip          TEXT,
  success     BIGINT NOT NULL DEFAULT 0,
  reason      TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public.customers (
  id             TEXT PRIMARY KEY,
  user_id        TEXT REFERENCES users (id) ON DELETE SET NULL,
  company_name   TEXT,
  contact_name   TEXT NOT NULL,
  email          TEXT,
  phone          TEXT,
  country        TEXT,
  city           TEXT,
  locale         TEXT NOT NULL DEFAULT 'ar',
  currency       TEXT NOT NULL DEFAULT 'USD',
  timezone       TEXT,
  source         TEXT,
  status         TEXT NOT NULL CHECK (status IN ('LEAD', 'ACTIVE', 'PAUSED', 'ARCHIVED')),
  goals          TEXT,
  needs          TEXT,
  ai_summary     TEXT,
  internal_notes TEXT,
  owner_user_id  TEXT REFERENCES users (id) ON DELETE SET NULL,
  is_demo        BIGINT NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public.customer_facts (
  id           TEXT PRIMARY KEY,
  customer_id  TEXT NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  fact_key     TEXT NOT NULL,
  fact_value   TEXT NOT NULL,
  source       TEXT NOT NULL CHECK (source IN ('CHAT', 'FORM', 'AGENT', 'STAFF', 'IMPORT')),
  confidence   DOUBLE PRECISION NOT NULL DEFAULT 1,
  verified     BIGINT NOT NULL DEFAULT 0,
  recorded_by  TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (customer_id, fact_key)
);

CREATE TABLE IF NOT EXISTS public.services (
  id                           TEXT PRIMARY KEY,
  slug                         TEXT NOT NULL UNIQUE,
  name_ar                      TEXT NOT NULL,
  name_en                      TEXT NOT NULL,
  short_ar                     TEXT,
  short_en                     TEXT,
  description_ar               TEXT,
  description_en               TEXT,
  category                     TEXT NOT NULL,
  billing_type                 TEXT NOT NULL CHECK (billing_type IN ('ONE_TIME', 'SUBSCRIPTION')),
  unit                         TEXT NOT NULL CHECK (unit IN ('PROJECT', 'MONTH', 'POST', 'DESIGN', 'CAMPAIGN', 'HOUR', 'REPORT')),
  base_price_minor             BIGINT NOT NULL DEFAULT 0,
  min_price_minor              BIGINT NOT NULL DEFAULT 0,
  currency                     TEXT NOT NULL DEFAULT 'USD',
  delivery_days                BIGINT NOT NULL DEFAULT 7,
  revisions_included           BIGINT NOT NULL DEFAULT 2,
  complexity_factor            DOUBLE PRECISION NOT NULL DEFAULT 1,
  requires_approval_above_minor BIGINT,
  is_active                    BIGINT NOT NULL DEFAULT 1,
  sort_order                   BIGINT NOT NULL DEFAULT 0,
  pricing_config               TEXT,
  cancellation_policy          TEXT,
  created_at                   TEXT NOT NULL,
  updated_at                   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public.projects (
  id                 TEXT PRIMARY KEY,
  code               TEXT NOT NULL UNIQUE,
  customer_id        TEXT NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  title              TEXT NOT NULL,
  title_en           TEXT,
  brief              TEXT,
  status             TEXT NOT NULL CHECK (status IN (
                       'DRAFT', 'AWAITING_APPROVAL', 'AWAITING_PAYMENT', 'PLANNING',
                       'IN_PROGRESS', 'IN_REVIEW', 'REVISIONS', 'COMPLETED', 'CANCELLED')),
  currency           TEXT NOT NULL DEFAULT 'USD',
  amount_total_minor BIGINT NOT NULL DEFAULT 0,
  internal_cost_minor BIGINT NOT NULL DEFAULT 0,
  margin_pct         DOUBLE PRECISION,
  country            TEXT,
  progress           BIGINT NOT NULL DEFAULT 0,
  risk_level         TEXT CHECK (risk_level IN ('LOW', 'MEDIUM', 'HIGH')),
  start_date         TEXT,
  due_date           TEXT,
  completed_at       TEXT,
  ai_plan            TEXT,
  created_by_user_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_by_agent   TEXT,
  is_demo            BIGINT NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public.project_services (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  service_id       TEXT REFERENCES services (id) ON DELETE SET NULL,
  name_snapshot    TEXT NOT NULL,
  quantity         DOUBLE PRECISION NOT NULL DEFAULT 1,
  unit_price_minor BIGINT NOT NULL DEFAULT 0,
  billing_type     TEXT NOT NULL CHECK (billing_type IN ('ONE_TIME', 'SUBSCRIPTION')),
  months           BIGINT,
  notes            TEXT,
  created_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public.project_tasks (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  title          TEXT NOT NULL,
  title_en       TEXT,
  description    TEXT,
  status         TEXT NOT NULL CHECK (status IN ('TODO', 'IN_PROGRESS', 'BLOCKED', 'REVIEW', 'DONE')),
  visibility     TEXT NOT NULL DEFAULT 'CLIENT' CHECK (visibility IN ('CLIENT', 'INTERNAL')),
  sort_order     BIGINT NOT NULL DEFAULT 0,
  due_date       TEXT,
  completed_at   TEXT,
  assigned_agent TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public.offers (
  id                  TEXT PRIMARY KEY,
  code                TEXT NOT NULL UNIQUE,
  customer_id         TEXT NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  project_id          TEXT REFERENCES projects (id) ON DELETE SET NULL,
  status              TEXT NOT NULL CHECK (status IN ('DRAFT', 'SENT', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED')),
  currency            TEXT NOT NULL DEFAULT 'USD',
  subtotal_minor      BIGINT NOT NULL DEFAULT 0,
  discount_minor      BIGINT NOT NULL DEFAULT 0,
  total_minor         BIGINT NOT NULL DEFAULT 0,
  internal_cost_minor BIGINT NOT NULL DEFAULT 0,
  margin_pct          DOUBLE PRECISION,
  valid_until         TEXT,
  pricing_reason      TEXT,
  pricing_breakdown   TEXT,
  client_note         TEXT,
  internal_note       TEXT,
  created_by_agent    TEXT,
  created_by_user_id  TEXT REFERENCES users (id) ON DELETE SET NULL,
  approved_at         TEXT,
  rejected_at         TEXT,
  is_demo             BIGINT NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public.offer_items (
  id                TEXT PRIMARY KEY,
  offer_id          TEXT NOT NULL REFERENCES offers (id) ON DELETE CASCADE,
  service_id        TEXT REFERENCES services (id) ON DELETE SET NULL,
  description_ar    TEXT NOT NULL,
  description_en    TEXT,
  quantity          DOUBLE PRECISION NOT NULL DEFAULT 1,
  unit_price_minor  BIGINT NOT NULL DEFAULT 0,
  billing_type      TEXT NOT NULL CHECK (billing_type IN ('ONE_TIME', 'SUBSCRIPTION')),
  months            BIGINT,
  total_minor       BIGINT NOT NULL DEFAULT 0,
  sort_order        BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS public.invoices (
  id                       TEXT PRIMARY KEY,
  number                   TEXT NOT NULL UNIQUE,
  customer_id              TEXT NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  project_id               TEXT REFERENCES projects (id) ON DELETE SET NULL,
  offer_id                 TEXT REFERENCES offers (id) ON DELETE SET NULL,
  subscription_id          TEXT,
  currency                 TEXT NOT NULL DEFAULT 'USD',
  subtotal_minor           BIGINT NOT NULL DEFAULT 0,
  tax_minor                BIGINT NOT NULL DEFAULT 0,
  total_minor              BIGINT NOT NULL DEFAULT 0,
  amount_paid_minor        BIGINT NOT NULL DEFAULT 0,
  refunded_minor           BIGINT NOT NULL DEFAULT 0,
  status                   TEXT NOT NULL CHECK (status IN ('DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'CANCELLED', 'REFUNDED')),
  issued_at                TEXT,
  due_at                   TEXT,
  paid_at                  TEXT,
  notes_client             TEXT,
  internal_note            TEXT,
  policy_snapshot          TEXT,
  is_demo                  BIGINT NOT NULL DEFAULT 0,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public.subscriptions (
  id                     TEXT PRIMARY KEY,
  customer_id            TEXT NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  service_id             TEXT REFERENCES services (id) ON DELETE SET NULL,
  project_id             TEXT REFERENCES projects (id) ON DELETE SET NULL,
  plan_name              TEXT NOT NULL,
  amount_minor           BIGINT NOT NULL DEFAULT 0,
  currency               TEXT NOT NULL DEFAULT 'USD',
  interval               TEXT NOT NULL CHECK (interval IN ('MONTHLY', 'QUARTERLY', 'YEARLY')),
  interval_count         BIGINT NOT NULL DEFAULT 1,
  status                 TEXT NOT NULL CHECK (status IN ('ACTIVE', 'PAST_DUE', 'PAUSED', 'CANCELLED', 'EXPIRED')),
  started_at             TEXT NOT NULL,
  current_period_start   TEXT NOT NULL,
  current_period_end     TEXT NOT NULL,
  next_renewal_at        TEXT,
  auto_renew             BIGINT NOT NULL DEFAULT 0,
  cancel_at_period_end   BIGINT NOT NULL DEFAULT 0,
  cancelled_at           TEXT,
  cancellation_reason    TEXT,
  policy_snapshot        TEXT,
  is_demo                BIGINT NOT NULL DEFAULT 0,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public.payments (
  id                  TEXT PRIMARY KEY,
  invoice_id          TEXT REFERENCES invoices (id) ON DELETE SET NULL,
  customer_id         TEXT NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  subscription_id     TEXT REFERENCES subscriptions (id) ON DELETE SET NULL,
  amount_minor        BIGINT NOT NULL,
  refunded_minor      BIGINT NOT NULL DEFAULT 0,
  currency            TEXT NOT NULL DEFAULT 'USD',
  method              TEXT NOT NULL CHECK (method IN ('MANUAL_TRANSFER', 'CASH', 'CARD_ONLINE', 'WALLET', 'OTHER')),
  provider            TEXT NOT NULL DEFAULT 'manual',
  provider_ref        TEXT,
  status              TEXT NOT NULL CHECK (status IN ('PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED')),
  paid_at             TEXT,
  recorded_by_user_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  note                TEXT,
  is_demo             BIGINT NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public.conversations (
  id                  TEXT PRIMARY KEY,
  customer_id         TEXT NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  channel             TEXT NOT NULL CHECK (channel IN ('WEB', 'EMAIL', 'WHATSAPP', 'PHONE', 'SYSTEM')),
  subject             TEXT,
  status              TEXT NOT NULL CHECK (status IN ('OPEN', 'PENDING', 'CLOSED')),
  assigned_to_user_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  external_ref        TEXT,
  unread_for_client   BIGINT NOT NULL DEFAULT 0,
  unread_for_staff    BIGINT NOT NULL DEFAULT 0,
  last_message_at     TEXT,
  is_demo             BIGINT NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public.messages (
  id                  TEXT PRIMARY KEY,
  conversation_id     TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  sender_type         TEXT NOT NULL CHECK (sender_type IN ('CLIENT', 'ASSISTANT', 'STAFF', 'AGENT', 'SYSTEM')),
  sender_user_id      TEXT REFERENCES users (id) ON DELETE SET NULL,
  sender_label        TEXT,
  body                TEXT NOT NULL,
  language            TEXT,
  translated_body     TEXT,
  translated_language TEXT,
  meta                TEXT,
  created_at          TEXT NOT NULL,
  read_at             TEXT,
  is_demo             BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS public.files (
  id                TEXT PRIMARY KEY,
  customer_id       TEXT NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  project_id        TEXT REFERENCES projects (id) ON DELETE SET NULL,
  offer_id          TEXT REFERENCES offers (id) ON DELETE SET NULL,
  uploader_type     TEXT NOT NULL CHECK (uploader_type IN ('CLIENT', 'STAFF', 'AGENT', 'SYSTEM')),
  uploader_user_id  TEXT REFERENCES users (id) ON DELETE SET NULL,
  name              TEXT NOT NULL,
  kind              TEXT,
  mime              TEXT,
  size_bytes        BIGINT NOT NULL DEFAULT 0,
  storage_provider  TEXT NOT NULL DEFAULT 'local',
  storage_key       TEXT NOT NULL,
  visibility        TEXT NOT NULL DEFAULT 'CLIENT' CHECK (visibility IN ('CLIENT', 'INTERNAL')),
  checksum          TEXT,
  is_demo           BIGINT NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public.reviews (
  id             TEXT PRIMARY KEY,
  customer_id    TEXT NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  project_id     TEXT REFERENCES projects (id) ON DELETE SET NULL,
  rating         BIGINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  satisfaction   TEXT,
  liked          TEXT,
  improve        TEXT,
  wants_more     BIGINT NOT NULL DEFAULT 0,
  note           TEXT,
  status         TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  published      BIGINT NOT NULL DEFAULT 0,
  published_name TEXT,
  published_at   TEXT,
  source         TEXT NOT NULL DEFAULT 'PORTAL',
  is_demo        BIGINT NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public.activities (
  id             TEXT PRIMARY KEY,
  actor_type     TEXT NOT NULL CHECK (actor_type IN ('USER', 'AGENT', 'SYSTEM')),
  actor_user_id  TEXT REFERENCES users (id) ON DELETE SET NULL,
  actor_label    TEXT,
  action         TEXT NOT NULL,
  entity_type    TEXT,
  entity_id      TEXT,
  customer_id    TEXT REFERENCES customers (id) ON DELETE SET NULL,
  summary        TEXT,
  meta           TEXT,
  ip             TEXT,
  user_agent     TEXT,
  is_demo        BIGINT NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public.settings (
  key                TEXT PRIMARY KEY,
  value              TEXT NOT NULL,
  value_type         TEXT NOT NULL DEFAULT 'string' CHECK (value_type IN ('string', 'number', 'boolean', 'json')),
  updated_by_user_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  updated_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public.rate_limits (
  key           TEXT PRIMARY KEY,
  window_start  BIGINT NOT NULL,
  count         BIGINT NOT NULL DEFAULT 0,
  blocked_until BIGINT
);

CREATE INDEX IF NOT EXISTS idx_users_role_status ON users (role, status);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id, expires_at);

CREATE INDEX IF NOT EXISTS idx_verification_user_type ON verification_tokens (user_id, type);

CREATE INDEX IF NOT EXISTS idx_login_attempts_email ON login_attempts (email, created_at);

CREATE INDEX IF NOT EXISTS idx_customers_status ON customers (status, created_at);

CREATE INDEX IF NOT EXISTS idx_customers_user ON customers (user_id);

CREATE INDEX IF NOT EXISTS idx_services_active ON services (is_active, sort_order);

CREATE INDEX IF NOT EXISTS idx_projects_customer ON projects (customer_id, status);

CREATE INDEX IF NOT EXISTS idx_projects_status ON projects (status, due_date);

CREATE INDEX IF NOT EXISTS idx_project_services_project ON project_services (project_id);

CREATE INDEX IF NOT EXISTS idx_project_tasks_project ON project_tasks (project_id, sort_order);

CREATE INDEX IF NOT EXISTS idx_offers_customer ON offers (customer_id, status);

CREATE INDEX IF NOT EXISTS idx_offer_items_offer ON offer_items (offer_id);

CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices (customer_id, status);

CREATE INDEX IF NOT EXISTS idx_invoices_due ON invoices (status, due_at);

CREATE INDEX IF NOT EXISTS idx_payments_customer ON payments (customer_id, status);

CREATE INDEX IF NOT EXISTS idx_subscriptions_customer ON subscriptions (customer_id, status);

CREATE INDEX IF NOT EXISTS idx_subscriptions_renewal ON subscriptions (status, next_renewal_at);

CREATE INDEX IF NOT EXISTS idx_conversations_customer ON conversations (customer_id, status);

CREATE INDEX IF NOT EXISTS idx_conversations_channel ON conversations (channel, last_message_at);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages (conversation_id, created_at);

CREATE INDEX IF NOT EXISTS idx_files_customer ON files (customer_id, created_at);

CREATE INDEX IF NOT EXISTS idx_files_project ON files (project_id);

CREATE INDEX IF NOT EXISTS idx_reviews_public ON reviews (published, published_at);

CREATE INDEX IF NOT EXISTS idx_activities_created ON activities (created_at);

CREATE INDEX IF NOT EXISTS idx_activities_customer ON activities (customer_id, created_at);

CREATE INDEX IF NOT EXISTS idx_activities_entity ON activities (entity_type, entity_id);

CREATE TABLE IF NOT EXISTS public.agents (
  id              TEXT PRIMARY KEY,
  key             TEXT NOT NULL UNIQUE,
  name_ar         TEXT NOT NULL,
  name_en         TEXT NOT NULL,
  category        TEXT NOT NULL,
  description_ar  TEXT,
  description_en  TEXT,
  is_enabled      BIGINT NOT NULL DEFAULT 1,
  required_skills TEXT,
  sort_order      BIGINT NOT NULL DEFAULT 0,
  config          TEXT,
  updated_at      TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public.agent_runs (
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
  prompt_tokens     BIGINT NOT NULL DEFAULT 0,
  completion_tokens BIGINT NOT NULL DEFAULT 0,
  latency_ms        BIGINT NOT NULL DEFAULT 0,
  error             TEXT,
  is_demo           BIGINT NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  finished_at       TEXT
);

CREATE TABLE IF NOT EXISTS public.agent_actions (
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
  requires_approval   BIGINT NOT NULL DEFAULT 0,
  approved_by_user_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  approved_at         TEXT,
  payload             TEXT,
  is_demo             BIGINT NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public.campaigns (
  id                  TEXT PRIMARY KEY,
  customer_id         TEXT NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  project_id          TEXT REFERENCES projects (id) ON DELETE SET NULL,
  platform            TEXT NOT NULL CHECK (platform IN ('GOOGLE_ADS', 'META_ADS', 'TIKTOK', 'SNAPCHAT', 'X_ADS', 'LINKEDIN', 'OTHER')),
  external_id         TEXT,
  name                TEXT NOT NULL,
  objective           TEXT,
  status              TEXT NOT NULL CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED')),
  currency            TEXT NOT NULL DEFAULT 'USD',
  total_budget_minor  BIGINT NOT NULL DEFAULT 0,
  daily_budget_minor  BIGINT NOT NULL DEFAULT 0,
  monthly_budget_minor BIGINT NOT NULL DEFAULT 0,
  spent_minor         BIGINT NOT NULL DEFAULT 0,
  start_date          TEXT,
  end_date            TEXT,
  targeting           TEXT,
  keywords            TEXT,
  ad_copy             TEXT,
  autopilot_enabled   BIGINT NOT NULL DEFAULT 0,
  safe_limits         TEXT,
  sync_status         TEXT NOT NULL DEFAULT 'DISABLED' CHECK (sync_status IN ('DISABLED', 'NOT_CONNECTED', 'SYNCED', 'ERROR')),
  last_sync_at        TEXT,
  created_by_agent    TEXT,
  created_by_user_id  TEXT REFERENCES users (id) ON DELETE SET NULL,
  is_demo             BIGINT NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public.campaign_metrics_daily (
  id                   TEXT PRIMARY KEY,
  campaign_id          TEXT NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
  metric_date          TEXT NOT NULL,
  impressions          BIGINT NOT NULL DEFAULT 0,
  clicks               BIGINT NOT NULL DEFAULT 0,
  cost_minor           BIGINT NOT NULL DEFAULT 0,
  conversions          DOUBLE PRECISION NOT NULL DEFAULT 0,
  conversion_value_minor BIGINT NOT NULL DEFAULT 0,
  ctr                  DOUBLE PRECISION,
  cpc_minor            BIGINT,
  cpa_minor            BIGINT,
  source               TEXT NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL', 'API', 'IMPORT')),
  raw                  TEXT,
  created_at           TEXT NOT NULL,
  UNIQUE (campaign_id, metric_date)
);

CREATE TABLE IF NOT EXISTS public.campaign_changes (
  id              TEXT PRIMARY KEY,
  campaign_id     TEXT NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
  agent_key       TEXT,
  change_type     TEXT NOT NULL,
  before_state    TEXT,
  after_state     TEXT,
  reason          TEXT,
  risk_level      TEXT NOT NULL DEFAULT 'LOW' CHECK (risk_level IN ('LOW', 'MEDIUM', 'HIGH')),
  auto_applied    BIGINT NOT NULL DEFAULT 0,
  within_limits   BIGINT NOT NULL DEFAULT 1,
  approver_user_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  applied_at      TEXT,
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public.reports (
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
  is_demo           BIGINT NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public.alerts (
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
  is_demo               BIGINT NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public.notifications (
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

CREATE TABLE IF NOT EXISTS public.outbox_emails (
  id          TEXT PRIMARY KEY,
  to_email    TEXT NOT NULL,
  to_user_id  TEXT REFERENCES users (id) ON DELETE SET NULL,
  subject     TEXT NOT NULL,
  text        TEXT,
  html        TEXT,
  template    TEXT,
  status      TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED', 'SENT', 'FAILED')),
  provider    TEXT NOT NULL DEFAULT 'console',
  attempts    BIGINT NOT NULL DEFAULT 0,
  error       TEXT,
  meta        TEXT,
  sent_at     TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public.webhook_events (
  id              TEXT PRIMARY KEY,
  provider        TEXT NOT NULL,
  event_type      TEXT,
  external_id     TEXT,
  signature_valid BIGINT NOT NULL DEFAULT 0,
  payload         TEXT,
  status          TEXT NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED')),
  error           TEXT,
  processed_at    TEXT,
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public.integration_connections (
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

CREATE TABLE IF NOT EXISTS public.job_runs (
  id              TEXT PRIMARY KEY,
  job_key         TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED')),
  started_at      TEXT NOT NULL,
  finished_at     TEXT,
  items_processed BIGINT NOT NULL DEFAULT 0,
  summary         TEXT,
  error           TEXT,
  meta            TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_agent ON agent_runs (agent_key, created_at);

CREATE INDEX IF NOT EXISTS idx_agent_runs_customer ON agent_runs (customer_id, created_at);

CREATE INDEX IF NOT EXISTS idx_agent_actions_created ON agent_actions (created_at);

CREATE INDEX IF NOT EXISTS idx_agent_actions_pending ON agent_actions (requires_approval, approved_at);

CREATE INDEX IF NOT EXISTS idx_campaigns_customer ON campaigns (customer_id, status);

CREATE INDEX IF NOT EXISTS idx_campaigns_platform ON campaigns (platform, status);

CREATE INDEX IF NOT EXISTS idx_metrics_campaign_date ON campaign_metrics_daily (campaign_id, metric_date);

CREATE INDEX IF NOT EXISTS idx_campaign_changes_campaign ON campaign_changes (campaign_id, created_at);

CREATE INDEX IF NOT EXISTS idx_reports_customer ON reports (customer_id, created_at);

CREATE INDEX IF NOT EXISTS idx_reports_type ON reports (report_type, created_at);

CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts (status, severity, created_at);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (user_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox_emails (status, created_at);

CREATE INDEX IF NOT EXISTS idx_webhook_provider ON webhook_events (provider, created_at);

CREATE INDEX IF NOT EXISTS idx_job_runs_key ON job_runs (job_key, started_at);

ALTER TABLE public._migrations ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.activities ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.agent_actions ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.agent_runs ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.agents ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.alerts ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.campaign_changes ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.campaign_metrics_daily ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.campaigns ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.customer_facts ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.files ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.integration_connections ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.job_runs ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.login_attempts ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.offer_items ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.offers ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.outbox_emails ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.project_services ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.project_tasks ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.reviews ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.services ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.verification_tokens ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.webhook_events ENABLE ROW LEVEL SECURITY;

-- Mark the generated migrations as applied so `npm run db:migrate` is safe
-- after this manual SQL setup. Checksums are computed from the generated files.
INSERT INTO public._migrations (id, name, checksum, applied_at, duration_ms)
VALUES
  ('0001', 'core', '3500558b628b106db34ce80ac5bbbf0c6579bdaa8900e20f52d755f21418c658', CURRENT_TIMESTAMP::text, 0),
  ('0002', 'agents growth', '89dbf052a975332b4dae8a9f0dda7258d0afd507db362c7ad0284d0208d0df12', CURRENT_TIMESTAMP::text, 0),
  ('0003', 'enable rls', 'b538727df53995609cbb506e3956feca38f80d2ec640b141e6f2fe4adec30f0e', CURRENT_TIMESTAMP::text, 0)
ON CONFLICT (id) DO NOTHING;
