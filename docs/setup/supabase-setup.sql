-- Ofoq / Supabase PostgreSQL setup
-- Generated from db/migrations/sqlite/*.sql. Do not edit by hand.
-- Regenerate with: npm run db:generate-postgres
-- Creates 35 application tables plus the _migrations tracking table, the
-- Supabase portal objects, and the ai_usage log (37 tables in total).
-- Safe to re-run: existing tables and indexes are left unchanged.
-- The bundle also installs Supabase Auth triggers, RLS-safe REST RPCs, and column grants.
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

-- Supabase Auth, portal RPCs, RLS/column privileges and platform logs.
-- Source: db/migrations/supabase/0001_auth_portal.sql.
-- =============================================================================
-- Ofoq Supabase Auth + REST portal
-- -----------------------------------------------------------------------------
-- Apply after the generated core schema (`docs/setup/supabase-setup.sql`).
-- No service-role key is used by the application. Client access is via HTTPS
-- PostgREST RPC calls with the user's JWT; security-definer functions enforce
-- ownership, while direct table access remains revoked.
-- Re-runnable by design: triggers/policies are replaced and functions use
-- CREATE OR REPLACE.
-- =============================================================================

GRANT USAGE ON SCHEMA public TO anon, authenticated;

-- Start with no direct Data API access to the operational schema. The one
-- exception is a deliberately narrow SELECT grant on the caller's own profile.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.offer_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_metrics_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.files ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reviews ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ofoq_user_read_self ON public.users;
CREATE POLICY ofoq_user_read_self ON public.users
  FOR SELECT TO authenticated
  USING (id = (SELECT auth.uid())::text);

GRANT SELECT (id, email, name, role, status, locale, phone, country, avatar_url,
              email_verified_at, created_at, updated_at)
  ON TABLE public.users TO authenticated;

CREATE OR REPLACE FUNCTION public.ofoq_is_staff()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.users AS u
    WHERE u.id = (SELECT auth.uid())::text
      AND u.role IN ('OWNER', 'PARTNER')
      AND u.status = 'ACTIVE'
  );
$function$;
REVOKE ALL ON FUNCTION public.ofoq_is_staff() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ofoq_is_staff() TO authenticated;

-- Create the platform profile/customer record in the same transaction as Auth
-- signup. A new browser user can never choose their own role.
CREATE OR REPLACE FUNCTION public.ofoq_create_auth_profile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_now text := to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_email text := lower(coalesce(NEW.email, ''));
  v_name text := coalesce(
    nullif(trim(NEW.raw_user_meta_data ->> 'full_name'), ''),
    nullif(trim(NEW.raw_user_meta_data ->> 'name'), ''),
    nullif(split_part(coalesce(NEW.email, ''), '@', 1), ''),
    'Ofoq client'
  );
  v_locale text := CASE WHEN NEW.raw_user_meta_data ->> 'locale' = 'en' THEN 'en' ELSE 'ar' END;
  v_status text := CASE WHEN NEW.email_confirmed_at IS NOT NULL THEN 'ACTIVE' ELSE 'PENDING' END;
BEGIN
  IF v_email = '' THEN
    RAISE EXCEPTION 'An email address is required to create an Ofoq profile';
  END IF;

  INSERT INTO public.users
    (id, email, password_hash, name, role, status, locale, email_verified_at, is_demo, created_at, updated_at)
  VALUES
    (NEW.id::text, v_email, NULL, v_name, 'CLIENT', v_status, v_locale,
     NEW.email_confirmed_at::text, 0, v_now, v_now)
  ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    name = EXCLUDED.name,
    locale = EXCLUDED.locale,
    email_verified_at = EXCLUDED.email_verified_at,
    status = CASE
      WHEN public.users.status IN ('SUSPENDED', 'DELETED') THEN public.users.status
      ELSE EXCLUDED.status
    END,
    updated_at = EXCLUDED.updated_at;

  INSERT INTO public.customers
    (id, user_id, contact_name, email, locale, currency, source, status, is_demo, created_at, updated_at)
  VALUES
    (NEW.id::text, NEW.id::text, v_name, v_email, v_locale, 'USD', 'WEB', 'LEAD', 0, v_now, v_now)
  ON CONFLICT (id) DO UPDATE SET
    user_id = EXCLUDED.user_id,
    contact_name = EXCLUDED.contact_name,
    email = EXCLUDED.email,
    locale = EXCLUDED.locale,
    updated_at = EXCLUDED.updated_at;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.ofoq_sync_auth_profile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_now text := to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  UPDATE public.users
  SET email = lower(coalesce(NEW.email, public.users.email)),
      email_verified_at = NEW.email_confirmed_at::text,
      status = CASE
        WHEN public.users.status IN ('SUSPENDED', 'DELETED') THEN public.users.status
        WHEN NEW.email_confirmed_at IS NOT NULL THEN 'ACTIVE'
        ELSE public.users.status
      END,
      updated_at = v_now
  WHERE id = NEW.id::text;

  UPDATE public.customers
  SET email = lower(coalesce(NEW.email, public.customers.email)),
      updated_at = v_now
  WHERE user_id = NEW.id::text;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS ofoq_auth_user_created ON auth.users;
CREATE TRIGGER ofoq_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.ofoq_create_auth_profile();

DROP TRIGGER IF EXISTS ofoq_auth_user_updated ON auth.users;
CREATE TRIGGER ofoq_auth_user_updated
  AFTER UPDATE OF email, email_confirmed_at ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.ofoq_sync_auth_profile();

REVOKE ALL ON FUNCTION public.ofoq_create_auth_profile() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ofoq_sync_auth_profile() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.ofoq_client_dashboard()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_user_id text := (SELECT auth.uid())::text;
  v_customer_id text;
  v_customer jsonb;
  v_projects jsonb;
  v_offers jsonb;
  v_invoices jsonb;
  v_payments jsonb;
  v_subscriptions jsonb;
  v_campaigns jsonb;
  v_reports jsonb;
  v_files jsonb;
BEGIN
  IF v_user_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.users AS u WHERE u.id = v_user_id AND u.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'Authentication required or account inactive' USING ERRCODE = '28000';
  END IF;

  SELECT c.id INTO v_customer_id
  FROM public.customers AS c
  WHERE c.user_id = v_user_id
  ORDER BY c.created_at ASC
  LIMIT 1;

  IF v_customer_id IS NULL THEN
    RETURN jsonb_build_object(
      'customer', NULL, 'projects', '[]'::jsonb, 'offers', '[]'::jsonb,
      'invoices', '[]'::jsonb, 'payments', '[]'::jsonb, 'subscriptions', '[]'::jsonb,
      'campaigns', '[]'::jsonb, 'reports', '[]'::jsonb, 'files', '[]'::jsonb
    );
  END IF;

  SELECT jsonb_build_object(
    'id', c.id, 'name', c.contact_name, 'companyName', c.company_name,
    'email', c.email, 'phone', c.phone, 'country', c.country, 'city', c.city,
    'locale', c.locale, 'currency', c.currency, 'goals', c.goals, 'needs', c.needs
  ) INTO v_customer
  FROM public.customers AS c
  WHERE c.id = v_customer_id;

  SELECT coalesce(jsonb_agg(item ORDER BY created_at DESC), '[]'::jsonb) INTO v_projects
  FROM (
    SELECT p.created_at,
      jsonb_build_object(
        'id', p.id, 'code', p.code, 'title', p.title, 'titleEn', p.title_en,
        'brief', p.brief, 'status', p.status, 'progress', p.progress,
        'currency', p.currency, 'amountTotalMinor', p.amount_total_minor,
        'startDate', p.start_date, 'dueDate', p.due_date,
        'createdAt', p.created_at,
        'tasks', coalesce((
          SELECT jsonb_agg(jsonb_build_object(
            'id', t.id, 'title', t.title, 'titleEn', t.title_en,
            'status', t.status, 'dueDate', t.due_date, 'sortOrder', t.sort_order
          ) ORDER BY t.sort_order)
          FROM public.project_tasks AS t
          WHERE t.project_id = p.id AND t.visibility = 'CLIENT'
        ), '[]'::jsonb)
      ) AS item
    FROM public.projects AS p
    WHERE p.customer_id = v_customer_id
      AND p.status <> 'CANCELLED'
    ORDER BY p.created_at DESC
    LIMIT 20
  ) AS project_rows;

  SELECT coalesce(jsonb_agg(item ORDER BY created_at DESC), '[]'::jsonb) INTO v_offers
  FROM (
    SELECT o.created_at,
      jsonb_build_object(
        'id', o.id, 'code', o.code, 'status', o.status, 'currency', o.currency,
        'subtotalMinor', o.subtotal_minor, 'discountMinor', o.discount_minor,
        'totalMinor', o.total_minor, 'validUntil', o.valid_until,
        'clientNote', o.client_note, 'createdAt', o.created_at,
        'items', coalesce((
          SELECT jsonb_agg(jsonb_build_object(
            'descriptionAr', oi.description_ar, 'descriptionEn', oi.description_en,
            'quantity', oi.quantity, 'unitPriceMinor', oi.unit_price_minor,
            'billingType', oi.billing_type, 'months', oi.months, 'totalMinor', oi.total_minor
          ) ORDER BY oi.sort_order)
          FROM public.offer_items AS oi WHERE oi.offer_id = o.id
        ), '[]'::jsonb)
      ) AS item
    FROM public.offers AS o
    WHERE o.customer_id = v_customer_id
      AND o.status NOT IN ('CANCELLED', 'EXPIRED')
    ORDER BY o.created_at DESC
    LIMIT 20
  ) AS offer_rows;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', i.id, 'number', i.number, 'currency', i.currency, 'subtotalMinor', i.subtotal_minor,
    'taxMinor', i.tax_minor, 'totalMinor', i.total_minor, 'amountPaidMinor', i.amount_paid_minor,
    'status', i.status, 'issuedAt', i.issued_at, 'dueAt', i.due_at, 'paidAt', i.paid_at,
    'notes', i.notes_client, 'createdAt', i.created_at
  ) ORDER BY i.created_at DESC), '[]'::jsonb) INTO v_invoices
  FROM public.invoices AS i
  WHERE i.customer_id = v_customer_id AND i.status <> 'CANCELLED';

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', p.id, 'invoiceId', p.invoice_id, 'amountMinor', p.amount_minor,
    'refundedMinor', p.refunded_minor, 'currency', p.currency, 'method', p.method,
    'status', p.status, 'paidAt', p.paid_at, 'createdAt', p.created_at
  ) ORDER BY p.created_at DESC), '[]'::jsonb) INTO v_payments
  FROM public.payments AS p
  WHERE p.customer_id = v_customer_id;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', s.id, 'planName', s.plan_name, 'amountMinor', s.amount_minor,
    'currency', s.currency, 'interval', s.interval, 'status', s.status,
    'periodEnd', s.current_period_end, 'nextRenewalAt', s.next_renewal_at,
    'cancelAtPeriodEnd', s.cancel_at_period_end
  ) ORDER BY s.created_at DESC), '[]'::jsonb) INTO v_subscriptions
  FROM public.subscriptions AS s
  WHERE s.customer_id = v_customer_id;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id, 'name', c.name, 'platform', c.platform, 'status', c.status,
    'currency', c.currency, 'totalBudgetMinor', c.total_budget_minor,
    'dailyBudgetMinor', c.daily_budget_minor, 'spentMinor', c.spent_minor,
    'startDate', c.start_date, 'endDate', c.end_date, 'syncStatus', c.sync_status
  ) ORDER BY c.created_at DESC), '[]'::jsonb) INTO v_campaigns
  FROM public.campaigns AS c
  WHERE c.customer_id = v_customer_id AND c.status <> 'ARCHIVED';

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id, 'title', r.title, 'summary', r.summary, 'body', r.body,
    'type', r.report_type, 'language', r.language, 'periodStart', r.period_start,
    'periodEnd', r.period_end, 'status', r.status, 'createdAt', r.created_at
  ) ORDER BY r.created_at DESC), '[]'::jsonb) INTO v_reports
  FROM public.reports AS r
  WHERE r.customer_id = v_customer_id AND r.status = 'SENT';

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', f.id, 'name', f.name, 'kind', f.kind, 'mime', f.mime,
    'sizeBytes', f.size_bytes, 'projectId', f.project_id, 'createdAt', f.created_at
  ) ORDER BY f.created_at DESC), '[]'::jsonb) INTO v_files
  FROM public.files AS f
  WHERE f.customer_id = v_customer_id AND f.visibility = 'CLIENT';

  RETURN jsonb_build_object(
    'customer', v_customer, 'projects', v_projects, 'offers', v_offers,
    'invoices', v_invoices, 'payments', v_payments, 'subscriptions', v_subscriptions,
    'campaigns', v_campaigns, 'reports', v_reports, 'files', v_files
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.ofoq_admin_dashboard()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_clients jsonb;
  v_requests jsonb;
  v_projects jsonb;
  v_campaigns jsonb;
  v_reports jsonb;
  v_alerts jsonb;
  v_agent_actions jsonb;
  v_financials jsonb;
BEGIN
  IF NOT public.ofoq_is_staff() THEN
    RAISE EXCEPTION 'Staff access required' USING ERRCODE = '42501';
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id, 'name', c.contact_name, 'companyName', c.company_name,
    'email', c.email, 'country', c.country, 'status', c.status,
    'createdAt', c.created_at
  ) ORDER BY c.created_at DESC), '[]'::jsonb) INTO v_clients
  FROM (SELECT * FROM public.customers ORDER BY created_at DESC LIMIT 8) AS c;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', o.id, 'code', o.code, 'status', o.status, 'currency', o.currency,
    'totalMinor', o.total_minor, 'createdByAgent', o.created_by_agent,
    'createdAt', o.created_at, 'customerName', c.contact_name,
    'customerEmail', c.email
  ) ORDER BY o.created_at DESC), '[]'::jsonb) INTO v_requests
  FROM (SELECT * FROM public.offers ORDER BY created_at DESC LIMIT 8) AS o
  JOIN public.customers AS c ON c.id = o.customer_id;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', p.id, 'code', p.code, 'title', p.title, 'status', p.status,
    'progress', p.progress, 'dueDate', p.due_date, 'customerName', c.contact_name,
    'amountTotalMinor', p.amount_total_minor, 'internalCostMinor', p.internal_cost_minor,
    'createdAt', p.created_at
  ) ORDER BY p.updated_at DESC), '[]'::jsonb) INTO v_projects
  FROM (SELECT * FROM public.projects ORDER BY updated_at DESC LIMIT 8) AS p
  JOIN public.customers AS c ON c.id = p.customer_id;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id, 'name', c.name, 'platform', c.platform, 'status', c.status,
    'currency', c.currency, 'totalBudgetMinor', c.total_budget_minor,
    'dailyBudgetMinor', c.daily_budget_minor, 'monthlyBudgetMinor', c.monthly_budget_minor,
    'spentMinor', c.spent_minor, 'syncStatus', c.sync_status,
    'customerName', u.contact_name, 'updatedAt', c.updated_at
  ) ORDER BY c.updated_at DESC), '[]'::jsonb) INTO v_campaigns
  FROM (SELECT * FROM public.campaigns ORDER BY updated_at DESC LIMIT 8) AS c
  JOIN public.customers AS u ON u.id = c.customer_id;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id, 'title', r.title, 'type', r.report_type, 'status', r.status,
    'customerName', c.contact_name, 'createdAt', r.created_at
  ) ORDER BY r.created_at DESC), '[]'::jsonb) INTO v_reports
  FROM (SELECT * FROM public.reports ORDER BY created_at DESC LIMIT 8) AS r
  JOIN public.customers AS c ON c.id = r.customer_id;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', a.id, 'severity', a.severity, 'category', a.category,
    'titleAr', a.title_ar, 'titleEn', a.title_en, 'bodyAr', a.body_ar,
    'bodyEn', a.body_en, 'status', a.status, 'createdAt', a.created_at
  ) ORDER BY a.created_at DESC), '[]'::jsonb) INTO v_alerts
  FROM (SELECT * FROM public.alerts WHERE status IN ('NEW', 'ACKNOWLEDGED')
        AND target_role <> 'CLIENT' ORDER BY created_at DESC LIMIT 8) AS a;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', a.id, 'agentKey', a.agent_key, 'action', a.action,
    'summary', a.summary, 'reason', a.reason, 'riskLevel', a.risk_level,
    'requiresApproval', a.requires_approval, 'createdAt', a.created_at
  ) ORDER BY a.created_at DESC), '[]'::jsonb) INTO v_agent_actions
  FROM (SELECT * FROM public.agent_actions ORDER BY created_at DESC LIMIT 8) AS a;

  SELECT jsonb_build_object(
    'collected30d', coalesce((
      SELECT jsonb_agg(jsonb_build_object('currency', x.currency, 'totalMinor', x.total_minor))
      FROM (
        SELECT currency, sum(amount_paid_minor) AS total_minor
        FROM public.invoices
        WHERE updated_at >= to_char(timezone('utc', now()) - interval '30 days', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        GROUP BY currency
      ) AS x
    ), '[]'::jsonb),
    'internalCost30d', coalesce((
      SELECT jsonb_agg(jsonb_build_object('currency', x.currency, 'totalMinor', x.total_minor))
      FROM (
        SELECT currency, sum(internal_cost_minor) AS total_minor
        FROM public.projects
        WHERE created_at >= to_char(timezone('utc', now()) - interval '30 days', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          AND status <> 'CANCELLED'
        GROUP BY currency
      ) AS x
    ), '[]'::jsonb)
  ) INTO v_financials;

  RETURN jsonb_build_object(
    'generatedAt', to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'totals', jsonb_build_object(
      'customers', (SELECT count(*) FROM public.customers),
      'newCustomers7d', (SELECT count(*) FROM public.customers WHERE created_at >= to_char(timezone('utc', now()) - interval '7 days', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
      'activeProjects', (SELECT count(*) FROM public.projects WHERE status IN ('PLANNING', 'IN_PROGRESS', 'IN_REVIEW', 'REVISIONS')),
      'overdueProjects', (SELECT count(*) FROM public.projects WHERE due_date < (timezone('utc', now())::date)::text AND status IN ('PLANNING', 'IN_PROGRESS', 'IN_REVIEW', 'REVISIONS')),
      'newRequests', (SELECT count(*) FROM public.offers WHERE status IN ('DRAFT', 'SENT')),
      'activeCampaigns', (SELECT count(*) FROM public.campaigns WHERE status = 'ACTIVE'),
      'reports30d', (SELECT count(*) FROM public.reports WHERE created_at >= to_char(timezone('utc', now()) - interval '30 days', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
      'pendingAgentActions', (SELECT count(*) FROM public.agent_actions WHERE requires_approval = 1 AND approved_at IS NULL),
      'urgentAlerts', (SELECT count(*) FROM public.alerts WHERE severity = 'URGENT' AND status IN ('NEW', 'ACKNOWLEDGED'))
    ),
    'clients', v_clients, 'requests', v_requests, 'projects', v_projects,
    'campaigns', v_campaigns, 'reports', v_reports, 'alerts', v_alerts,
    'agentActions', v_agent_actions, 'financials', v_financials,
    'integrations', jsonb_build_object(
      'googleAds', jsonb_build_object('status', 'NOT_CONNECTED'),
      'whatsapp', jsonb_build_object('status', 'DISABLED'),
      'payments', jsonb_build_object('status', 'MANUAL_ONLY')
    )
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.ofoq_public_reviews()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'rating', r.rating, 'satisfaction', r.satisfaction, 'liked', r.liked,
    'publishedName', coalesce(r.published_name, 'عميل أفق'),
    'createdAt', r.published_at
  ) ORDER BY r.published_at DESC), '[]'::jsonb)
  FROM public.reviews AS r
  WHERE r.published = 1 AND r.status = 'APPROVED';
$function$;

CREATE OR REPLACE FUNCTION public.ofoq_client_chat_bootstrap()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_user_id text := (SELECT auth.uid())::text;
  v_customer_id text;
  v_customer_name text;
  v_locale text;
  v_conversation_id text;
  v_messages jsonb;
  v_now text := to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  IF v_user_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.users AS u WHERE u.id = v_user_id AND u.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'Authentication required or account inactive' USING ERRCODE = '28000';
  END IF;

  SELECT c.id, c.contact_name, c.locale
  INTO v_customer_id, v_customer_name, v_locale
  FROM public.customers AS c
  WHERE c.user_id = v_user_id
  ORDER BY c.created_at ASC
  LIMIT 1;

  IF v_customer_id IS NULL THEN
    RAISE EXCEPTION 'Client profile is not ready';
  END IF;

  SELECT c.id INTO v_conversation_id
  FROM public.conversations AS c
  WHERE c.customer_id = v_customer_id AND c.channel = 'WEB' AND c.status <> 'CLOSED'
  ORDER BY coalesce(c.last_message_at, c.created_at) DESC
  LIMIT 1;

  IF v_conversation_id IS NULL THEN
    v_conversation_id := gen_random_uuid()::text;
    INSERT INTO public.conversations
      (id, customer_id, channel, subject, status, unread_for_client, unread_for_staff,
       is_demo, created_at, updated_at)
    VALUES
      (v_conversation_id, v_customer_id, 'WEB', 'محادثة مساعد أفق', 'OPEN', 0, 0, 0, v_now, v_now);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.messages WHERE conversation_id = v_conversation_id) THEN
    INSERT INTO public.messages
      (id, conversation_id, sender_type, sender_label, body, language, meta, created_at, is_demo)
    VALUES
      (gen_random_uuid()::text, v_conversation_id, 'ASSISTANT',
       CASE WHEN v_locale = 'en' THEN 'Ofoq assistant' ELSE 'مساعد أفق' END,
       CASE WHEN v_locale = 'en'
         THEN 'Welcome to Ofoq. I am the agency’s AI assistant. Tell me what you would like to achieve, and I will guide you one step at a time. You can ask for a human team member at any time.'
         ELSE 'أهلًا بك في أفق. أنا مساعد أفق، مساعد ذكي تابع للوكالة. أخبرني بما تريد تحقيقه وسأرشدك خطوة بخطوة. يمكنك طلب التواصل مع فريق بشري في أي وقت.'
       END,
       v_locale,
       jsonb_build_object('step', 'greeting', 'disclosure', true)::text,
       v_now, 0);
  END IF;

  SELECT coalesce(jsonb_agg(message ORDER BY created_at), '[]'::jsonb) INTO v_messages
  FROM (
    SELECT jsonb_build_object(
      'id', m.id, 'sender', m.sender_type, 'body', m.body,
      'language', m.language, 'createdAt', m.created_at,
      -- Provider that wrote an assistant reply ("groq", "cohere", … or "rules"),
      -- so the client can label the message with a small "بواسطة Groq" badge.
      -- `meta` is TEXT holding a JSON object; the guard keeps malformed legacy
      -- values from breaking the whole conversation load.
      'provider', CASE WHEN coalesce(m.meta, '') LIKE '{%' THEN nullif(m.meta::jsonb ->> 'provider', '') ELSE NULL END
    ) AS message, m.created_at
    FROM public.messages AS m
    WHERE m.conversation_id = v_conversation_id
    ORDER BY m.created_at DESC
    LIMIT 80
  ) AS recent;

  RETURN jsonb_build_object(
    'conversationId', v_conversation_id, 'customerName', v_customer_name,
    'language', v_locale, 'messages', v_messages
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.ofoq_client_chat_send(p_body text, p_language text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_chat jsonb;
  v_user_id text := (SELECT auth.uid())::text;
  v_conversation_id text;
  v_language text;
  v_history jsonb;
  v_message_id text := gen_random_uuid()::text;
  v_now text := to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  IF v_user_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.users AS u WHERE u.id = v_user_id AND u.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'Authentication required or account inactive' USING ERRCODE = '28000';
  END IF;
  IF p_body IS NULL OR length(trim(p_body)) = 0 OR length(p_body) > 2000 THEN
    RAISE EXCEPTION 'Message must contain between 1 and 2000 characters';
  END IF;

  v_chat := public.ofoq_client_chat_bootstrap();
  v_conversation_id := v_chat ->> 'conversationId';
  v_language := CASE WHEN p_language IN ('ar', 'en') THEN p_language ELSE coalesce(v_chat ->> 'language', 'ar') END;

  IF (
    SELECT count(*) FROM public.messages AS m
    WHERE m.conversation_id = v_conversation_id
      AND m.sender_type = 'CLIENT'
      AND m.created_at >= to_char(timezone('utc', now()) - interval '1 minute', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ) >= 20 THEN
    RAISE EXCEPTION 'Too many messages. Please wait a moment.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.messages
    (id, conversation_id, sender_type, sender_user_id, sender_label, body, language, created_at, is_demo)
  VALUES
    (v_message_id, v_conversation_id, 'CLIENT', v_user_id, 'Client', trim(p_body), v_language, v_now, 0);

  UPDATE public.conversations
  SET unread_for_staff = unread_for_staff + 1, last_message_at = v_now, updated_at = v_now
  WHERE id = v_conversation_id;

  SELECT coalesce(jsonb_agg(message ORDER BY created_at), '[]'::jsonb) INTO v_history
  FROM (
    SELECT jsonb_build_object(
      'role', CASE WHEN m.sender_type = 'ASSISTANT' THEN 'assistant' ELSE 'user' END,
      'content', m.body
    ) AS message, m.created_at
    FROM public.messages AS m
    WHERE m.conversation_id = v_conversation_id
      AND m.sender_type IN ('CLIENT', 'ASSISTANT')
    ORDER BY m.created_at DESC
    LIMIT 20
  ) AS recent;

  RETURN jsonb_build_object(
    'conversationId', v_conversation_id, 'customerName', v_chat ->> 'customerName',
    'language', v_language, 'messages', v_history,
    'userMessage', jsonb_build_object('id', v_message_id, 'sender', 'CLIENT', 'body', trim(p_body), 'language', v_language, 'createdAt', v_now)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.ofoq_client_chat_reply(
  p_conversation_id text, p_body text, p_language text DEFAULT 'ar', p_provider text DEFAULT 'rules'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_user_id text := (SELECT auth.uid())::text;
  v_customer_id text;
  v_now text := to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_message_id text := gen_random_uuid()::text;
  v_language text := CASE WHEN p_language IN ('ar', 'en') THEN p_language ELSE 'ar' END;
BEGIN
  IF v_user_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.users AS u WHERE u.id = v_user_id AND u.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'Authentication required or account inactive' USING ERRCODE = '28000';
  END IF;
  IF p_body IS NULL OR length(trim(p_body)) = 0 OR length(p_body) > 5000 THEN
    RAISE EXCEPTION 'Reply is invalid';
  END IF;

  SELECT c.customer_id INTO v_customer_id
  FROM public.conversations AS c
  JOIN public.customers AS u ON u.id = c.customer_id
  WHERE c.id = p_conversation_id AND u.user_id = v_user_id AND c.channel = 'WEB';
  IF v_customer_id IS NULL THEN
    RAISE EXCEPTION 'Conversation not found' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.messages
    (id, conversation_id, sender_type, sender_label, body, language, meta, created_at, is_demo)
  VALUES
    (v_message_id, p_conversation_id, 'ASSISTANT',
     CASE WHEN v_language = 'en' THEN 'Ofoq assistant' ELSE 'مساعد أفق' END,
     trim(p_body), v_language,
     jsonb_build_object('provider', coalesce(nullif(p_provider, ''), 'rules'), 'aiDisclosure', true)::text,
     v_now, 0);

  UPDATE public.conversations
  SET unread_for_client = unread_for_client + 1, last_message_at = v_now, updated_at = v_now
  WHERE id = p_conversation_id;

  RETURN jsonb_build_object(
    'id', v_message_id, 'sender', 'ASSISTANT', 'body', trim(p_body),
    'language', v_language, 'createdAt', v_now,
    'provider', coalesce(nullif(p_provider, ''), 'rules')
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.ofoq_client_dashboard() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ofoq_admin_dashboard() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ofoq_client_chat_bootstrap() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ofoq_client_chat_send(text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ofoq_client_chat_reply(text, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ofoq_public_reviews() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.ofoq_client_dashboard() TO authenticated;
GRANT EXECUTE ON FUNCTION public.ofoq_admin_dashboard() TO authenticated;
GRANT EXECUTE ON FUNCTION public.ofoq_client_chat_bootstrap() TO authenticated;
GRANT EXECUTE ON FUNCTION public.ofoq_client_chat_send(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ofoq_client_chat_reply(text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ofoq_public_reviews() TO anon, authenticated;

-- Supabase Auth, portal RPCs, RLS/column privileges and platform logs.
-- Source: db/migrations/supabase/0002_ai_usage.sql.
-- =============================================================================
-- Ofoq AI usage log (public.ai_usage)
-- -----------------------------------------------------------------------------
-- Stores one row per AI provider attempt (success, rate limit, timeout, error,
-- skipped provider). Written by the API routes through `ofoq_ai_usage_record`
-- and read by the owner-only `ofoq_ai_usage_admin` RPC that backs
-- /admin/settings/integrations.
--
-- Design notes:
--   * Direct table access stays revoked for anon/authenticated; RLS is enabled
--     with no policies. Both access paths are SECURITY DEFINER functions.
--   * No API key, prompt or model answer is ever stored here: only provider,
--     model id, token counts, status and duration.
--   * Re-runnable by design (IF NOT EXISTS / CREATE OR REPLACE).
--
-- Apply after db/migrations/supabase/0001_auth_portal.sql.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.ai_usage (
  id              TEXT PRIMARY KEY,
  provider        TEXT NOT NULL,
  model           TEXT NOT NULL,
  agent_key       TEXT,
  customer_id     TEXT,
  input_tokens    INTEGER DEFAULT 0,
  output_tokens   INTEGER DEFAULT 0,
  status          TEXT NOT NULL,
  duration_ms     INTEGER DEFAULT 0,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_provider ON public.ai_usage (provider, created_at DESC);

-- The integrations screen asks for "the last 10 requests" and "today's usage",
-- which this index serves directly.
CREATE INDEX IF NOT EXISTS idx_ai_usage_created_at ON public.ai_usage (created_at DESC);

ALTER TABLE public.ai_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ai_usage FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Role helper (owner-only surfaces)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ofoq_is_owner()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.users AS u
    WHERE u.id = (SELECT auth.uid())::text
      AND u.role = 'OWNER'
      AND u.status = 'ACTIVE'
  );
$function$;

REVOKE ALL ON FUNCTION public.ofoq_is_owner() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ofoq_is_owner() TO authenticated;

-- -----------------------------------------------------------------------------
-- Write path — one usage row per provider attempt
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ofoq_ai_usage_record(
  p_id            text,
  p_provider      text,
  p_model         text,
  p_agent_key     text DEFAULT NULL,
  p_customer_id   text DEFAULT NULL,
  p_input_tokens  integer DEFAULT 0,
  p_output_tokens integer DEFAULT 0,
  p_status        text DEFAULT 'OK',
  p_duration_ms   integer DEFAULT 0
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_user_id text := (SELECT auth.uid())::text;
  v_is_staff boolean := public.ofoq_is_staff();
  v_customer_id text;
  v_provider text := lower(trim(coalesce(p_provider, '')));
  v_model text := left(trim(coalesce(p_model, '')), 120);
  v_status text := upper(trim(coalesce(p_status, 'OK')));
  v_id text := coalesce(nullif(trim(coalesce(p_id, '')), ''), gen_random_uuid()::text);
  v_now text := to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  IF v_user_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.users AS u WHERE u.id = v_user_id AND u.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'Authentication required or account inactive' USING ERRCODE = '28000';
  END IF;

  IF v_provider = '' OR length(v_provider) > 40 THEN
    RAISE EXCEPTION 'Invalid provider';
  END IF;

  IF v_status NOT IN ('OK', 'RATE_LIMIT', 'TIMEOUT', 'PROVIDER_ERROR', 'MISSING_KEY', 'EMPTY_RESPONSE', 'UNAVAILABLE') THEN
    v_status := 'PROVIDER_ERROR';
  END IF;

  IF v_model = '' THEN
    v_model := 'unknown';
  END IF;

  -- Attribution is never client-chosen: a client row always belongs to the
  -- caller's own customer record; staff may attribute to any customer or none.
  IF v_is_staff THEN
    v_customer_id := nullif(trim(coalesce(p_customer_id, '')), '');
  ELSE
    SELECT c.id INTO v_customer_id
    FROM public.customers AS c
    WHERE c.user_id = v_user_id
    ORDER BY c.created_at ASC
    LIMIT 1;

    -- Cheap abuse guard: a single client account cannot write unlimited rows.
    IF (
      SELECT count(*) FROM public.ai_usage AS a
      WHERE a.customer_id = v_customer_id
        AND a.created_at >= to_char(timezone('utc', now()) - interval '1 minute', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ) >= 60 THEN
      RAISE EXCEPTION 'Too many AI usage records. Please wait a moment.' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  INSERT INTO public.ai_usage
    (id, provider, model, agent_key, customer_id, input_tokens, output_tokens, status, duration_ms, created_at)
  VALUES
    (v_id, v_provider, v_model, nullif(trim(coalesce(p_agent_key, '')), ''), v_customer_id,
     greatest(0, coalesce(p_input_tokens, 0)), greatest(0, coalesce(p_output_tokens, 0)),
     v_status, greatest(0, coalesce(p_duration_ms, 0)), v_now)
  ON CONFLICT (id) DO NOTHING;

  RETURN v_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.ofoq_ai_usage_record(text, text, text, text, text, integer, integer, text, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ofoq_ai_usage_record(text, text, text, text, text, integer, integer, text, integer)
  TO authenticated;

-- -----------------------------------------------------------------------------
-- Read path — owner-only summary for /admin/settings/integrations
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ofoq_ai_usage_admin()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_today jsonb;
  v_recent jsonb;
  v_day_start text := to_char(date_trunc('day', timezone('utc', now())), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  IF NOT public.ofoq_is_owner() THEN
    RAISE EXCEPTION 'Owner access required' USING ERRCODE = '42501';
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'provider', t.provider,
    'requests', t.requests,
    'failures', t.failures,
    'inputTokens', t.input_tokens,
    'outputTokens', t.output_tokens
  ) ORDER BY t.provider), '[]'::jsonb) INTO v_today
  FROM (
    SELECT a.provider,
           count(*)::int AS requests,
           count(*) FILTER (WHERE a.status <> 'OK')::int AS failures,
           coalesce(sum(a.input_tokens), 0)::int AS input_tokens,
           coalesce(sum(a.output_tokens), 0)::int AS output_tokens
    FROM public.ai_usage AS a
    WHERE a.created_at >= v_day_start
    GROUP BY a.provider
  ) AS t;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id, 'provider', r.provider, 'model', r.model,
    'agentKey', r.agent_key, 'customerId', r.customer_id,
    'inputTokens', r.input_tokens, 'outputTokens', r.output_tokens,
    'status', r.status, 'durationMs', r.duration_ms, 'createdAt', r.created_at
  ) ORDER BY r.created_at DESC), '[]'::jsonb) INTO v_recent
  FROM (SELECT * FROM public.ai_usage ORDER BY created_at DESC LIMIT 10) AS r;

  RETURN jsonb_build_object(
    'generatedAt', to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'today', v_today,
    'recent', v_recent
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.ofoq_ai_usage_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ofoq_ai_usage_admin() TO authenticated;

-- Mark the generated migrations as applied so `npm run db:migrate` is safe
-- after this manual SQL setup. Checksums are computed from the generated files.
INSERT INTO public._migrations (id, name, checksum, applied_at, duration_ms)
VALUES
  ('0001', 'core', '3500558b628b106db34ce80ac5bbbf0c6579bdaa8900e20f52d755f21418c658', CURRENT_TIMESTAMP::text, 0),
  ('0002', 'agents growth', '89dbf052a975332b4dae8a9f0dda7258d0afd507db362c7ad0284d0208d0df12', CURRENT_TIMESTAMP::text, 0),
  ('0003', 'enable rls', 'b538727df53995609cbb506e3956feca38f80d2ec640b141e6f2fe4adec30f0e', CURRENT_TIMESTAMP::text, 0)
ON CONFLICT (id) DO NOTHING;
