-- Ofoq / Supabase PostgreSQL setup
-- Generated from db/migrations/sqlite/*.sql. Do not edit by hand.
-- Regenerate with: npm run db:generate-postgres
-- Creates 35 application tables plus _migrations, ai_usage, and the
-- private service-request price-verification table (38 tables in total).
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

CREATE TABLE IF NOT EXISTS public.project_plans (
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_project_plans_project_version ON project_plans (project_id, version);

CREATE INDEX IF NOT EXISTS idx_project_plans_project ON project_plans (project_id, status);

ALTER TABLE public.project_tasks ADD COLUMN IF NOT EXISTS internal_note TEXT;

ALTER TABLE public.project_tasks ADD COLUMN IF NOT EXISTS phase_key TEXT;

CREATE INDEX IF NOT EXISTS idx_project_tasks_phase ON project_tasks (project_id, phase_key);

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

ALTER TABLE public.project_plans ENABLE ROW LEVEL SECURITY;

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

ALTER TABLE public.offers ALTER COLUMN subtotal_minor DROP NOT NULL;

ALTER TABLE public.offers ALTER COLUMN total_minor DROP NOT NULL;

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

-- Every account that can sign in must be able to talk to the assistant —
-- whatever its role. The `ofoq_create_auth_profile` trigger below creates the
-- `customers` row together with the Auth user, but accounts that existed before
-- the trigger (or that were promoted to OWNER/PARTNER later) have a `users` row
-- and no `customers` row. This lazily creates the missing client record, using
-- the same convention as the trigger (customers.id = users.id).
--
-- It never creates accounts and never touches another user's record.
CREATE OR REPLACE FUNCTION public.ofoq_ensure_customer_profile()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_user_id text := (SELECT auth.uid())::text;
  v_now text := to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_customer_id text;
  v_email text;
  v_name text;
  v_locale text;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  -- The normal path: the account already has a client record.
  SELECT c.id INTO v_customer_id
  FROM public.customers AS c
  WHERE c.user_id = v_user_id
  ORDER BY c.created_at ASC
  LIMIT 1;

  IF v_customer_id IS NOT NULL THEN
    RETURN v_customer_id;
  END IF;

  SELECT u.email, u.name, u.locale
  INTO v_email, v_name, v_locale
  FROM public.users AS u
  WHERE u.id = v_user_id AND u.status = 'ACTIVE';

  IF v_email IS NULL THEN
    RAISE EXCEPTION 'Authentication required or account inactive' USING ERRCODE = '28000';
  END IF;

  -- customers.id = users.id, exactly like the signup trigger does. A
  -- conflicting id that belongs to somebody else is left untouched by the
  -- WHERE clause, so this can never re-point a real client record.
  INSERT INTO public.customers
    (id, user_id, contact_name, email, locale, currency, source, status, is_demo, created_at, updated_at)
  VALUES
    (v_user_id, v_user_id,
     coalesce(nullif(trim(v_name), ''), nullif(split_part(lower(v_email), '@', 1), ''), 'Ofoq client'),
     lower(v_email), coalesce(v_locale, 'ar'), 'USD', 'WEB', 'LEAD', 0, v_now, v_now)
  ON CONFLICT (id) DO UPDATE
    SET user_id = EXCLUDED.user_id,
        email = coalesce(public.customers.email, EXCLUDED.email),
        updated_at = EXCLUDED.updated_at
    WHERE public.customers.user_id IS NULL OR public.customers.user_id = EXCLUDED.user_id;

  SELECT c.id INTO v_customer_id
  FROM public.customers AS c
  WHERE c.user_id = v_user_id
  ORDER BY c.created_at ASC
  LIMIT 1;

  RETURN v_customer_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.ofoq_ensure_customer_profile() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ofoq_ensure_customer_profile() TO authenticated;

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
  v_leads jsonb;
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
    'bodyEn', a.body_en, 'status', a.status, 'createdAt', a.created_at,
    'entityType', a.entity_type, 'entityId', a.entity_id,
    'customerName', c.contact_name, 'customerEmail', c.email
  ) ORDER BY a.created_at DESC), '[]'::jsonb) INTO v_alerts
  FROM (SELECT * FROM public.alerts WHERE status IN ('NEW', 'ACKNOWLEDGED')
        AND target_role <> 'CLIENT' ORDER BY created_at DESC LIMIT 12) AS a
  LEFT JOIN public.customers AS c ON c.id = a.customer_id;

  -- "New requests" the assistant produced: clients who asked for a human or
  -- whose need is now understood. These are alerts, not offers, and they are
  -- the ones the owner must not miss.
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', a.id, 'severity', a.severity, 'category', a.category, 'status', a.status,
    'titleAr', a.title_ar, 'titleEn', a.title_en, 'bodyAr', a.body_ar,
    'bodyEn', a.body_en, 'conversationId', a.entity_id, 'createdAt', a.created_at,
    'customerName', c.contact_name, 'customerEmail', c.email
  ) ORDER BY a.created_at DESC), '[]'::jsonb) INTO v_leads
  FROM (SELECT * FROM public.alerts
        WHERE category IN ('NEW_LEAD', 'HUMAN_REQUEST', 'NEW_REQUEST') AND status IN ('NEW', 'ACKNOWLEDGED')
        ORDER BY created_at DESC LIMIT 12) AS a
  LEFT JOIN public.customers AS c ON c.id = a.customer_id;

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
      -- "Urgent alerts" card: everything that needs a human, URGENT and IMPORTANT.
      'urgentAlerts', (SELECT count(*) FROM public.alerts WHERE severity IN ('URGENT', 'IMPORTANT') AND status IN ('NEW', 'ACKNOWLEDGED') AND target_role <> 'CLIENT'),
      'criticalAlerts', (SELECT count(*) FROM public.alerts WHERE severity = 'URGENT' AND status IN ('NEW', 'ACKNOWLEDGED') AND target_role <> 'CLIENT'),
      -- Open client requests raised by the assistant: human handoffs
      -- (HUMAN_REQUEST), understood briefs (NEW_LEAD) and guided service
      -- requests (NEW_REQUEST, migration 0008).
      'newLeads', (SELECT count(*) FROM public.alerts WHERE category IN ('NEW_LEAD', 'HUMAN_REQUEST', 'NEW_REQUEST') AND status IN ('NEW', 'ACKNOWLEDGED'))
    ),
    'clients', v_clients, 'requests', v_requests, 'projects', v_projects,
    'campaigns', v_campaigns, 'reports', v_reports, 'alerts', v_alerts,
    'leadRequests', v_leads,
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
  v_customer_email text;
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

  -- An owner or partner has no `customers` row until they chat for the first
  -- time; create it here instead of refusing the conversation, because
  -- «Client profile is not ready» used to lock owners out of their own
  -- assistant (and left every later escalation impossible).
  v_customer_id := public.ofoq_ensure_customer_profile();

  IF v_customer_id IS NULL THEN
    RAISE EXCEPTION 'Client profile is not ready' USING ERRCODE = '28000';
  END IF;

  SELECT c.contact_name, c.email, c.locale
  INTO v_customer_name, v_customer_email, v_locale
  FROM public.customers AS c
  WHERE c.id = v_customer_id;

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

  -- `email` lets the guided service request address the client by the address
  -- registered to the account (shown in the pricing message and the confirmation).
  RETURN jsonb_build_object(
    'conversationId', v_conversation_id, 'customerName', v_customer_name,
    'email', v_customer_email, 'language', v_locale, 'messages', v_messages
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

-- Supabase Auth, portal RPCs, RLS/column privileges and platform logs.
-- Source: db/migrations/supabase/0003_escalation_alerts.sql.
-- =============================================================================
-- Ofoq client escalation → real alerts, notifications and owner handoff
-- -----------------------------------------------------------------------------
-- Called by POST /api/chat through src/lib/services/escalation.service.ts when
-- the escalation agent decides a conversation needs a human:
--
--   public.ofoq_client_escalate(...)          one transaction that
--       1. inserts the `alerts` row (severity URGENT|IMPORTANT, category
--          HUMAN_REQUEST|NEW_LEAD, entity_type 'conversation', target_role
--          'ANY_STAFF', status 'NEW'),
--       2. sets conversations.status = 'PENDING',
--       3. writes IN_APP + EMAIL `notifications` for every active OWNER/PARTNER,
--       4. logs the event in `activities`,
--       and returns what the route needs to email the owner truthfully.
--
--   public.ofoq_escalation_email_result(...)  records whether the owner email
--       was actually delivered, so a failed send is visible instead of silent.
--
-- Design notes:
--   * No service-role key. Both functions are SECURITY DEFINER, re-check the
--     caller's JWT and verify the caller owns the conversation.
--   * Deduplicated per conversation, category and UTC day through
--     `alerts.dedupe_key`, so a client asking twice cannot flood /admin. A
--     RESOLVED alert is re-opened instead of being ignored.
--   * Re-runnable by design (CREATE OR REPLACE).
--
-- Apply after db/migrations/supabase/0001_auth_portal.sql.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.ofoq_client_escalate(
  p_conversation_id text,
  p_category text,
  p_severity text,
  p_title_ar text,
  p_title_en text,
  p_body_ar text DEFAULT NULL,
  p_body_en text DEFAULT NULL,
  p_reason text DEFAULT NULL,
  p_signals text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_user_id text := (SELECT auth.uid())::text;
  v_customer_id text;
  v_customer_name text;
  v_customer_email text;
  v_category text := upper(coalesce(trim(p_category), 'HUMAN_REQUEST'));
  v_severity text := upper(coalesce(trim(p_severity), 'IMPORTANT'));
  v_alert_id text;
  v_dedupe_key text;
  v_created boolean := false;
  v_staff jsonb;
  v_now text := to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_day text := to_char(timezone('utc', now()), 'YYYY-MM-DD');
BEGIN
  IF v_user_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.users AS u WHERE u.id = v_user_id AND u.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'Authentication required or account inactive' USING ERRCODE = '28000';
  END IF;

  IF v_category NOT IN ('HUMAN_REQUEST', 'NEW_LEAD') THEN
    RAISE EXCEPTION 'Unknown escalation category' USING ERRCODE = '22023';
  END IF;
  IF v_severity NOT IN ('URGENT', 'IMPORTANT') THEN
    RAISE EXCEPTION 'Unknown escalation severity' USING ERRCODE = '22023';
  END IF;
  IF p_conversation_id IS NULL OR length(trim(p_conversation_id)) = 0 THEN
    RAISE EXCEPTION 'A conversation id is required' USING ERRCODE = '22023';
  END IF;

  -- Ownership: only the client who owns this conversation can escalate it.
  SELECT c.customer_id, cu.contact_name, cu.email
  INTO v_customer_id, v_customer_name, v_customer_email
  FROM public.conversations AS c
  JOIN public.customers AS cu ON cu.id = c.customer_id
  WHERE c.id = p_conversation_id AND cu.user_id = v_user_id AND c.channel = 'WEB';

  IF v_customer_id IS NULL THEN
    RAISE EXCEPTION 'Conversation not found' USING ERRCODE = '42501';
  END IF;

  v_dedupe_key := 'escalation:' || p_conversation_id || ':' || v_category || ':' || v_day;

  SELECT a.id INTO v_alert_id FROM public.alerts AS a WHERE a.dedupe_key = v_dedupe_key;

  IF v_alert_id IS NOT NULL THEN
    -- Already raised today. A closed alert is re-opened: the client asked
    -- again, so the team must see it again.
    IF EXISTS (SELECT 1 FROM public.alerts WHERE id = v_alert_id AND status = 'RESOLVED') THEN
      UPDATE public.alerts
      SET status = 'NEW',
          severity = v_severity,
          acknowledged_by_user_id = NULL,
          acknowledged_at = NULL,
          resolved_at = NULL,
          body_ar = coalesce(p_body_ar, body_ar),
          body_en = coalesce(p_body_en, body_en),
          updated_at = v_now
      WHERE id = v_alert_id;
      v_created := true;
    END IF;
  ELSE
    v_alert_id := gen_random_uuid()::text;
    INSERT INTO public.alerts
      (id, severity, category, title_ar, title_en, body_ar, body_en,
       entity_type, entity_id, customer_id, target_role, status,
       dedupe_key, meta, is_demo, created_at, updated_at)
    VALUES
      (v_alert_id, v_severity, v_category,
       coalesce(nullif(trim(p_title_ar), ''), 'عميل جديد يطلب تواصل'),
       coalesce(nullif(trim(p_title_en), ''), 'New client requesting contact'),
       p_body_ar, p_body_en,
       'conversation', p_conversation_id, v_customer_id, 'ANY_STAFF', 'NEW',
       v_dedupe_key,
       jsonb_build_object(
         'source', 'escalation-agent',
         'reason', p_reason,
         'signals', p_signals,
         'clientName', v_customer_name,
         'clientEmail', v_customer_email
       )::text,
       0, v_now, v_now);
    v_created := true;
  END IF;

  -- The conversation now waits for a human being.
  UPDATE public.conversations
  SET status = 'PENDING',
      unread_for_staff = unread_for_staff + 1,
      updated_at = v_now
  WHERE id = p_conversation_id AND status <> 'CLOSED';

  -- Everyone who may act on it: active owners and partners.
  SELECT coalesce(
    jsonb_agg(jsonb_build_object('id', u.id, 'email', u.email, 'name', u.name) ORDER BY u.created_at),
    '[]'::jsonb
  )
  INTO v_staff
  FROM public.users AS u
  WHERE u.role IN ('OWNER', 'PARTNER') AND u.status = 'ACTIVE';

  -- Only for a new (or re-opened) alert: a client who keeps typing must not
  -- fill the team's inbox with copies of an alert that is already open.
  IF v_created THEN
    -- In-app notifications are delivered the moment they exist.
    INSERT INTO public.notifications (id, user_id, alert_id, channel, subject, body, status, created_at)
    SELECT gen_random_uuid()::text, s ->> 'id', v_alert_id, 'IN_APP',
           CASE WHEN v_severity = 'URGENT' THEN '🔴 ' || p_title_ar ELSE p_title_ar END,
           coalesce(p_body_ar, p_title_ar), 'SENT', v_now
    FROM jsonb_array_elements(v_staff) AS s;

    -- Email rows start QUEUED; ofoq_escalation_email_result reports the outcome.
    INSERT INTO public.notifications (id, user_id, alert_id, channel, subject, body, status, created_at)
    SELECT gen_random_uuid()::text, s ->> 'id', v_alert_id, 'EMAIL',
           p_title_ar, coalesce(p_body_ar, p_title_ar), 'QUEUED', v_now
    FROM jsonb_array_elements(v_staff) AS s;
  END IF;

  INSERT INTO public.activities
    (id, actor_type, actor_label, action, entity_type, entity_id, customer_id,
     summary, meta, is_demo, created_at)
  VALUES
    (gen_random_uuid()::text, 'SYSTEM', 'escalation-agent', 'escalation.raised',
     'alert', v_alert_id, v_customer_id,
     '[' || v_severity || '] ' || coalesce(nullif(trim(p_title_ar), ''), 'عميل جديد يطلب تواصل'),
     jsonb_build_object(
       'category', v_category,
       'conversationId', p_conversation_id,
       'created', v_created,
       'reason', p_reason
     )::text,
     0, v_now);

  RETURN jsonb_build_object(
    'alertId', v_alert_id,
    'created', v_created,
    'severity', v_severity,
    'category', v_category,
    'conversationId', p_conversation_id,
    'conversationStatus', (SELECT c.status FROM public.conversations AS c WHERE c.id = p_conversation_id),
    'clientName', coalesce(v_customer_name, ''),
    'clientEmail', coalesce(v_customer_email, ''),
    'staff', coalesce(v_staff, '[]'::jsonb)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.ofoq_escalation_email_result(
  p_alert_id text,
  p_delivered boolean,
  p_provider text DEFAULT NULL,
  p_error text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_user_id text := (SELECT auth.uid())::text;
  v_now text := to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_updated integer;
BEGIN
  IF v_user_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.users AS u WHERE u.id = v_user_id AND u.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'Authentication required or account inactive' USING ERRCODE = '28000';
  END IF;

  -- Only the client who raised the escalation, or a staff member, may report on it.
  IF NOT public.ofoq_is_staff() AND NOT EXISTS (
    SELECT 1
    FROM public.alerts AS a
    JOIN public.conversations AS c ON c.id = a.entity_id
    JOIN public.customers AS cu ON cu.id = c.customer_id
    WHERE a.id = p_alert_id AND a.entity_type = 'conversation' AND cu.user_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'Not allowed to update this alert' USING ERRCODE = '42501';
  END IF;

  UPDATE public.notifications
  SET status = CASE WHEN coalesce(p_delivered, false) THEN 'SENT' ELSE 'FAILED' END,
      error = CASE WHEN coalesce(p_delivered, false) THEN NULL ELSE left(coalesce(p_error, 'not delivered'), 500) END,
      sent_at = CASE WHEN coalesce(p_delivered, false) THEN v_now ELSE NULL END
  WHERE alert_id = p_alert_id AND channel = 'EMAIL';

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  RETURN jsonb_build_object(
    'alertId', p_alert_id,
    'delivered', coalesce(p_delivered, false),
    'provider', coalesce(nullif(trim(p_provider), ''), 'console'),
    'updated', v_updated,
    'updatedAt', v_now
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.ofoq_client_escalate(text, text, text, text, text, text, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ofoq_escalation_email_result(text, boolean, text, text) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.ofoq_client_escalate(text, text, text, text, text, text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ofoq_escalation_email_result(text, boolean, text, text) TO authenticated;

-- Supabase Auth, portal RPCs, RLS/column privileges and platform logs.
-- Source: db/migrations/supabase/0004_escalation_owner_support.sql.
-- =============================================================================
-- Ofoq — escalation that works for every signed-in account (OWNER included)
-- -----------------------------------------------------------------------------
-- Symptom this file fixes
-- -----------------------
-- The assistant answered «تم تسجيل طلبك للتواصل مع فريق بشري…» and then added
-- «لكن تعذّر تسجيل تنبيه التحويل المباشر الآن». In other words: the reply was
-- saved, the handoff was NOT.
--
-- Root cause
-- ----------
-- public.ofoq_client_escalate() resolved the caller with
--
--     SELECT c.customer_id FROM conversations c
--       JOIN customers cu ON cu.id = c.customer_id
--      WHERE c.id = p_conversation_id AND cu.user_id = auth.uid() AND …
--
-- and raised «Conversation not found» (42501) whenever that join produced no
-- row. The join needs a row in `customers` for the *caller*. Accounts that were
-- created before the `ofoq_create_auth_profile` signup trigger existed — or
-- that were promoted to OWNER/PARTNER later — have a `users` row but no
-- `customers` row, so the lookup returned NULL and the function aborted
-- BEFORE the `alerts` INSERT. No alert, no notification, no owner email.
-- Owners are exactly the accounts most likely to have no customer record, so
-- the handoff failed for the one person testing it.
--
-- What changes here
-- -----------------
--   1. A one-off backfill: every existing account without a customer record
--      gets one the moment this file is applied — no need to wait for the
--      owner's next login. (public.ofoq_ensure_customer_profile(), added to
--      0001_auth_portal.sql, keeps every future account covered: the chat
--      bootstrap calls it before opening a conversation.)
--   2. public.ofoq_client_escalate() is rewritten:
--        * the conversation is resolved FIRST, so a missing customer row can
--          no longer make an existing conversation invisible;
--        * any ACTIVE OWNER/PARTNER may escalate any WEB conversation (they
--          are the team the alert is for), and the client who owns the
--          conversation keeps that right;
--        * alerts.customer_id may be NULL (the column is nullable and the
--          admin dashboard LEFT JOINs it) — the alert is still written;
--        * every refusal now says WHY (user, role, customer, conversation)
--          instead of the misleading «Conversation not found»;
--        * the result carries an `identity` block for the server logs.
--   3. An authenticated INSERT policy on public.alerts, so a future
--      client-side alert write is allowed by RLS. The table GRANT is still
--      (deliberately) revoked: the audited path remains the RPC.
--   4. public.ofoq_escalation_diagnostics() — one RPC that answers «why did
--      the escalation fail?» in production (role, customer record,
--      conversation ownership, schema state, staff recipients). Wired to
--      GET /api/debug/escalation and to section 8 of /debug.
--
-- Apply after db/migrations/supabase/0003_escalation_alerts.sql.
-- Re-runnable by design (CREATE OR REPLACE / IF NOT EXISTS / guarded DO block).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Backfill: every account that has no client record gets one right now
-- -----------------------------------------------------------------------------
DO $backfill$
DECLARE
  v_now text := to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_created integer := 0;
BEGIN
  INSERT INTO public.customers
    (id, user_id, contact_name, email, locale, currency, source, status, is_demo, created_at, updated_at)
  SELECT
    u.id,
    u.id,
    coalesce(nullif(trim(u.name), ''), nullif(split_part(lower(coalesce(u.email, '')), '@', 1), ''), 'Ofoq client'),
    lower(coalesce(u.email, '')),
    coalesce(u.locale, 'ar'),
    'USD',
    'WEB',
    'LEAD',
    0,
    v_now,
    v_now
  FROM public.users AS u
  WHERE NOT EXISTS (SELECT 1 FROM public.customers AS c WHERE c.user_id = u.id)
  ON CONFLICT (id) DO NOTHING;

  GET DIAGNOSTICS v_created = ROW_COUNT;
  RAISE NOTICE 'ofoq: % client record(s) created for accounts that had none', v_created;
END
$backfill$;

-- -----------------------------------------------------------------------------
-- 2. Escalation that any signed-in account can raise
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ofoq_client_escalate(
  p_conversation_id text,
  p_category text,
  p_severity text,
  p_title_ar text,
  p_title_en text,
  p_body_ar text DEFAULT NULL,
  p_body_en text DEFAULT NULL,
  p_reason text DEFAULT NULL,
  p_signals text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_user_id text := (SELECT auth.uid())::text;
  v_role text;
  v_is_staff boolean := false;
  v_conversation_id text;
  v_customer_id text;
  v_owner_user_id text;
  v_customer_name text;
  v_customer_email text;
  v_profile_name text;
  v_profile_email text;
  v_category text := upper(coalesce(trim(p_category), 'HUMAN_REQUEST'));
  v_severity text := upper(coalesce(trim(p_severity), 'IMPORTANT'));
  v_alert_id text;
  v_dedupe_key text;
  v_created boolean := false;
  v_staff jsonb;
  v_now text := to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_day text := to_char(timezone('utc', now()), 'YYYY-MM-DD');
BEGIN
  -- Who is calling? Read once; every refusal message below reports it.
  SELECT u.role INTO v_role
  FROM public.users AS u
  WHERE u.id = v_user_id AND u.status = 'ACTIVE';

  IF v_user_id IS NULL OR v_role IS NULL THEN
    RAISE EXCEPTION 'Authentication required or account inactive' USING ERRCODE = '28000';
  END IF;
  v_is_staff := v_role IN ('OWNER', 'PARTNER');

  IF v_category NOT IN ('HUMAN_REQUEST', 'NEW_LEAD') THEN
    RAISE EXCEPTION 'Unknown escalation category' USING ERRCODE = '22023';
  END IF;
  IF v_severity NOT IN ('URGENT', 'IMPORTANT') THEN
    RAISE EXCEPTION 'Unknown escalation severity' USING ERRCODE = '22023';
  END IF;
  IF p_conversation_id IS NULL OR length(trim(p_conversation_id)) = 0 THEN
    RAISE EXCEPTION 'A conversation id is required' USING ERRCODE = '22023';
  END IF;

  -- Resolve the conversation FIRST. The old version joined `customers` here,
  -- so an account without a client record got «Conversation not found» for a
  -- conversation that existed all along — the bug this migration fixes.
  SELECT c.id, c.customer_id
  INTO v_conversation_id, v_customer_id
  FROM public.conversations AS c
  WHERE c.id = p_conversation_id AND c.channel = 'WEB';

  IF v_conversation_id IS NULL THEN
    RAISE EXCEPTION 'Conversation not found (user=% role=% conversation=%)',
      v_user_id, v_role, coalesce(p_conversation_id, '-')
      USING ERRCODE = '42501';
  END IF;

  IF v_customer_id IS NOT NULL THEN
    SELECT cu.user_id, cu.contact_name, cu.email
    INTO v_owner_user_id, v_customer_name, v_customer_email
    FROM public.customers AS cu
    WHERE cu.id = v_customer_id;

    -- A conversation can outlive its client record when the foreign key was
    -- dropped or never created. The link is dropped rather than letting the
    -- foreign key abort the whole escalation: the alert is what the client is
    -- waiting for, and both `alerts.customer_id` and `activities.customer_id`
    -- are nullable.
    IF v_owner_user_id IS NULL AND NOT EXISTS (
      SELECT 1 FROM public.customers AS cu WHERE cu.id = v_customer_id
    ) THEN
      v_customer_id := NULL;
    END IF;
  END IF;

  -- Ownership: the client this conversation belongs to, or any active
  -- OWNER/PARTNER — the team the alert is raised for must never be blocked
  -- from raising one.
  IF NOT v_is_staff AND (v_owner_user_id IS NULL OR v_owner_user_id <> v_user_id) THEN
    RAISE EXCEPTION
      'Not allowed to escalate this conversation (user=% role=% customer=% owner=% conversation=%)',
      v_user_id, v_role, coalesce(v_customer_id, '-'), coalesce(v_owner_user_id, '-'), p_conversation_id
      USING ERRCODE = '42501';
  END IF;

  -- Identity for the alert body. A customer record is the best source; when it
  -- is missing (or blank) fall back to the platform profile, so the owner still
  -- sees who is asking. customer_id itself stays NULL — the column is nullable
  -- and /admin LEFT JOINs it — because the alert matters more than the link.
  SELECT u.name, u.email INTO v_profile_name, v_profile_email
  FROM public.users AS u
  WHERE u.id = coalesce(v_owner_user_id, v_user_id);

  v_customer_name := coalesce(nullif(trim(v_customer_name), ''), nullif(trim(v_profile_name), ''), 'عميل أفق');
  v_customer_email := coalesce(nullif(trim(v_customer_email), ''), nullif(trim(v_profile_email), ''));

  v_dedupe_key := 'escalation:' || p_conversation_id || ':' || v_category || ':' || v_day;

  SELECT a.id INTO v_alert_id FROM public.alerts AS a WHERE a.dedupe_key = v_dedupe_key;

  IF v_alert_id IS NOT NULL THEN
    -- Already raised today. A closed alert is re-opened: the client asked
    -- again, so the team must see it again.
    IF EXISTS (SELECT 1 FROM public.alerts WHERE id = v_alert_id AND status = 'RESOLVED') THEN
      UPDATE public.alerts
      SET status = 'NEW',
          severity = v_severity,
          acknowledged_by_user_id = NULL,
          acknowledged_at = NULL,
          resolved_at = NULL,
          body_ar = coalesce(p_body_ar, body_ar),
          body_en = coalesce(p_body_en, body_en),
          updated_at = v_now
      WHERE id = v_alert_id;
      v_created := true;
    END IF;
  ELSE
    v_alert_id := gen_random_uuid()::text;
    INSERT INTO public.alerts
      (id, severity, category, title_ar, title_en, body_ar, body_en,
       entity_type, entity_id, customer_id, target_role, status,
       dedupe_key, meta, is_demo, created_at, updated_at)
    VALUES
      (v_alert_id, v_severity, v_category,
       coalesce(nullif(trim(p_title_ar), ''), 'عميل جديد يطلب تواصل'),
       coalesce(nullif(trim(p_title_en), ''), 'New client requesting contact'),
       p_body_ar, p_body_en,
       'conversation', p_conversation_id, v_customer_id, 'ANY_STAFF', 'NEW',
       v_dedupe_key,
       jsonb_build_object(
         'source', 'escalation-agent',
         'reason', p_reason,
         'signals', p_signals,
         'clientName', v_customer_name,
         'clientEmail', v_customer_email,
         'raisedByRole', v_role,
         'raisedByUserId', v_user_id
       )::text,
       0, v_now, v_now);
    v_created := true;
  END IF;

  -- The conversation now waits for a human being.
  UPDATE public.conversations
  SET status = 'PENDING',
      unread_for_staff = unread_for_staff + 1,
      updated_at = v_now
  WHERE id = p_conversation_id AND status <> 'CLOSED';

  -- Everyone who may act on it: active owners and partners.
  SELECT coalesce(
    jsonb_agg(jsonb_build_object('id', u.id, 'email', u.email, 'name', u.name) ORDER BY u.created_at),
    '[]'::jsonb
  )
  INTO v_staff
  FROM public.users AS u
  WHERE u.role IN ('OWNER', 'PARTNER') AND u.status = 'ACTIVE';

  -- Only for a new (or re-opened) alert: a client who keeps typing must not
  -- fill the team's inbox with copies of an alert that is already open.
  IF v_created THEN
    -- In-app notifications are delivered the moment they exist.
    INSERT INTO public.notifications (id, user_id, alert_id, channel, subject, body, status, created_at)
    SELECT gen_random_uuid()::text, s ->> 'id', v_alert_id, 'IN_APP',
           CASE WHEN v_severity = 'URGENT' THEN '🔴 ' || p_title_ar ELSE p_title_ar END,
           coalesce(p_body_ar, p_title_ar), 'SENT', v_now
    FROM jsonb_array_elements(v_staff) AS s;

    -- Email rows start QUEUED; ofoq_escalation_email_result reports the outcome.
    INSERT INTO public.notifications (id, user_id, alert_id, channel, subject, body, status, created_at)
    SELECT gen_random_uuid()::text, s ->> 'id', v_alert_id, 'EMAIL',
           p_title_ar, coalesce(p_body_ar, p_title_ar), 'QUEUED', v_now
    FROM jsonb_array_elements(v_staff) AS s;
  END IF;

  INSERT INTO public.activities
    (id, actor_type, actor_label, action, entity_type, entity_id, customer_id,
     summary, meta, is_demo, created_at)
  VALUES
    (gen_random_uuid()::text, 'SYSTEM', 'escalation-agent', 'escalation.raised',
     'alert', v_alert_id, v_customer_id,
     '[' || v_severity || '] ' || coalesce(nullif(trim(p_title_ar), ''), 'عميل جديد يطلب تواصل'),
     jsonb_build_object(
       'category', v_category,
       'conversationId', p_conversation_id,
       'created', v_created,
       'reason', p_reason,
       'raisedByRole', v_role
     )::text,
     0, v_now);

  RETURN jsonb_build_object(
    'alertId', v_alert_id,
    'created', v_created,
    'severity', v_severity,
    'category', v_category,
    'conversationId', p_conversation_id,
    'conversationStatus', (SELECT c.status FROM public.conversations AS c WHERE c.id = p_conversation_id),
    'clientName', coalesce(v_customer_name, ''),
    'clientEmail', coalesce(v_customer_email, ''),
    -- Everything the server log needs when something still goes wrong.
    'identity', jsonb_build_object(
      'userId', v_user_id,
      'role', v_role,
      'isStaff', v_is_staff,
      'customerId', v_customer_id,
      'conversationOwnerUserId', v_owner_user_id
    ),
    'staff', coalesce(v_staff, '[]'::jsonb)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.ofoq_client_escalate(text, text, text, text, text, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ofoq_client_escalate(text, text, text, text, text, text, text, text, text) TO authenticated;

-- -----------------------------------------------------------------------------
-- 3. Row Level Security: allow an authenticated INSERT on alerts
-- -----------------------------------------------------------------------------
-- RLS is already enabled on public.alerts by the generated schema. Without an
-- INSERT policy, a future client-side alert write would be refused by RLS even
-- if it was granted. The check is deliberately narrower than `true`: only an
-- escalation-shaped row (a conversation, addressed to the staff, and urgent
-- enough to matter) may be inserted, so an authenticated account cannot use
-- this table to inject arbitrary noise into /admin.
--
-- Note: the table GRANT is intentionally NOT issued here. `REVOKE ALL ON ALL
-- TABLES … FROM authenticated` (0001) stays in force, so the only writable path
-- remains public.ofoq_client_escalate(), which checks ownership, dedupes per
-- day and writes the notifications and the activity row with it.
ALTER TABLE public.alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS alerts_insert_authenticated ON public.alerts;
CREATE POLICY alerts_insert_authenticated ON public.alerts
  FOR INSERT TO authenticated
  WITH CHECK (
    entity_type = 'conversation'
    AND target_role = 'ANY_STAFF'
    AND severity IN ('URGENT', 'IMPORTANT')
  );

-- -----------------------------------------------------------------------------
-- 4. Diagnostics: «why did the escalation fail?», answered by the database
-- -----------------------------------------------------------------------------
-- Never raises for a missing table or column: it reports the state instead, so
-- it can be opened in the browser (GET /api/debug/escalation, or section 8 of
-- /debug) on a project where the portal migration was never fully applied.
CREATE OR REPLACE FUNCTION public.ofoq_escalation_diagnostics(p_conversation_id text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_user_id text := (SELECT auth.uid())::text;
  v_role text;
  v_status text;
  v_customer_id text;
  v_conversation_id text := nullif(trim(coalesce(p_conversation_id, '')), '');
  v_conversation jsonb := NULL;
  v_alerts jsonb;
  v_open_escalations integer := 0;
  v_staff jsonb;
BEGIN
  SELECT u.role, u.status INTO v_role, v_status
  FROM public.users AS u
  WHERE u.id = v_user_id;

  SELECT c.id INTO v_customer_id
  FROM public.customers AS c
  WHERE c.user_id = v_user_id
  ORDER BY c.created_at ASC
  LIMIT 1;

  -- No conversation id given? Use the caller's own web conversation.
  IF v_conversation_id IS NULL AND v_customer_id IS NOT NULL THEN
    SELECT c.id INTO v_conversation_id
    FROM public.conversations AS c
    WHERE c.customer_id = v_customer_id AND c.channel = 'WEB'
    ORDER BY coalesce(c.last_message_at, c.created_at) DESC
    LIMIT 1;
  END IF;

  IF v_conversation_id IS NOT NULL THEN
    SELECT jsonb_build_object(
      'id', c.id,
      'channel', c.channel,
      'status', c.status,
      'customerId', c.customer_id,
      'ownerUserId', cu.user_id,
      'ownedByCaller', cu.user_id IS NOT NULL AND cu.user_id = v_user_id,
      'customerRecordMissing', c.customer_id IS NOT NULL AND cu.id IS NULL,
      'exists', true
    ) INTO v_conversation
    FROM public.conversations AS c
    LEFT JOIN public.customers AS cu ON cu.id = c.customer_id
    WHERE c.id = v_conversation_id;

    IF v_conversation IS NULL THEN
      v_conversation := jsonb_build_object('id', v_conversation_id, 'exists', false);
    END IF;
  END IF;

  -- Schema checks. Every branch is guarded, so a missing table is reported
  -- instead of aborting the whole function.
  IF to_regclass('public.alerts') IS NULL THEN
    v_alerts := jsonb_build_object(
      'tableExists', false,
      'customerIdNullable', NULL,
      'dedupeColumnExists', false,
      'insertPolicyExists', false,
      'rlsEnabled', NULL,
      'openEscalations', NULL,
      'fix', 'Apply docs/setup/supabase-setup.sql (the public.alerts table is missing).'
    );
  ELSE
    SELECT jsonb_build_object(
      'tableExists', true,
      'customerIdNullable', coalesce((
        SELECT is_nullable = 'YES' FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'alerts' AND column_name = 'customer_id'
      ), false),
      'dedupeColumnExists', EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'alerts' AND column_name = 'dedupe_key'
      ),
      'insertPolicyExists', EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'alerts' AND cmd = 'INSERT'
      ),
      'rlsEnabled', (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.alerts')),
      'openEscalations', (
        SELECT count(*) FROM public.alerts
        WHERE category IN ('HUMAN_REQUEST', 'NEW_LEAD') AND status IN ('NEW', 'ACKNOWLEDGED')
      ),
      'fix', NULL
    ) INTO v_alerts;
  END IF;

  SELECT coalesce(
    jsonb_agg(jsonb_build_object('id', u.id, 'role', u.role, 'email', u.email) ORDER BY u.created_at),
    '[]'::jsonb
  ) INTO v_staff
  FROM public.users AS u
  WHERE u.role IN ('OWNER', 'PARTNER') AND u.status = 'ACTIVE';

  RETURN jsonb_build_object(
    'checkedAt', to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'caller', jsonb_build_object(
      'userId', v_user_id,
      'role', coalesce(v_role, 'NO_PROFILE'),
      'status', coalesce(v_status, 'NO_PROFILE'),
      'isStaff', coalesce(v_role, '') IN ('OWNER', 'PARTNER') AND coalesce(v_status, '') = 'ACTIVE',
      'customerId', v_customer_id,
      'hasCustomerRecord', v_customer_id IS NOT NULL
    ),
    'conversation', v_conversation,
    'alerts', v_alerts,
    'escalateFunctionExists', EXISTS (
      SELECT 1 FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'ofoq_client_escalate'
    ),
    'ensureProfileFunctionExists', EXISTS (
      SELECT 1 FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'ofoq_ensure_customer_profile'
    ),
    'staff', coalesce(v_staff, '[]'::jsonb)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.ofoq_escalation_diagnostics(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ofoq_escalation_diagnostics(text) TO authenticated;

-- Supabase Auth, portal RPCs, RLS/column privileges and platform logs.
-- Source: db/migrations/supabase/0006_escalate_manual_overload.sql.
-- =============================================================================
-- Ofoq — a 4-argument overload of public.ofoq_client_escalate (manual tests)
-- -----------------------------------------------------------------------------
-- Symptom this file fixes
-- -----------------------
--     ERROR: 42883: function public.ofoq_client_escalate(text, text, text, text) does not exist
--
-- Root cause
-- ----------
-- 42883 is Postgres' answer to «no function matches this NAME together with
-- this ARGUMENT LIST». It does not mean «nothing is installed». What 0003
-- installs and 0004 rewrites is the NINE-argument form:
--
--     ofoq_client_escalate(p_conversation_id, p_category, p_severity,
--                          p_title_ar, p_title_en, p_body_ar, p_body_en,
--                          p_reason, p_signals)
--
-- and that is the contract the application implements. The only call site is
-- `src/lib/services/escalation.service.ts` → `raiseClientEscalation()` →
-- `client.rpc("ofoq_client_escalate", { …nine p_* keys… })`.
-- `src/lib/agents/escalation-agent.ts` never touches Supabase: it is a pure
-- module that decides *whether* to escalate and builds the payload. So a
-- four-argument call from the SQL Editor finds no candidate function, while the
-- app's nine-argument call is unaffected by anything in this file.
--
-- What changes here
-- -----------------
--   1. public.ofoq_client_escalate(text, text, text, text) is added as a thin
--      overload with the signature the manual test (and the Arabic runbook
--      snippets) already use. It does not write anything itself: it maps its
--      four arguments onto the nine and delegates to the canonical function.
--      Dedupe, the `PENDING` conversation, the IN_APP/EMAIL notifications, the
--      `activities` row and the bilingual result therefore stay in ONE
--      implementation. A second, self-contained copy of the alert-writing logic
--      is how an escalation starts answering `ok` while quietly stopping to
--      notify the owner — so it is deliberately not written here.
--   2. No table privileges are granted or revoked. In particular this file does
--      NOT depend on the `GRANT INSERT, SELECT, UPDATE ON public.alerts TO
--      authenticated` that was applied to the live project as «0005»: the
--      function is SECURITY DEFINER and runs as the table owner, so it writes
--      `alerts` with or without that grant. The direct table path stays the
--      diagnostics probe it was designed to be (see `describeAlertInsertError`).
--   3. A guard reports which escalation objects this project actually has, and
--      says out loud when the canonical nine-argument function is missing
--      instead of letting the caller guess.
--   4. A copy-pasteable smoke test at the bottom, including the one thing the
--      SQL Editor does not have: a session user. `auth.uid()` is NULL there, so
--      BOTH overloads raise 28000 «Authentication required or account
--      inactive» — that error is the test working, not a new failure.
--
-- Apply after db/migrations/supabase/0004_escalation_owner_support.sql.
-- Re-runnable by design (CREATE OR REPLACE + guarded DO blocks).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Does this project have the nine-argument function the app calls?
-- -----------------------------------------------------------------------------
-- A named predicate on pg_proc rather than `to_regprocedure('…(text, text, …)')`,
-- because the type list of that cast is picky about whitespace — and a wrong
-- answer here is a migration that silently skips the grants.
--
-- It is deliberately NOT executable by anon/authenticated: it reports schema
-- state, and `ofoq_escalation_diagnostics()` is the RPC already designed to
-- answer that. The two SECURITY DEFINER callers run as the owner, which needs
-- no grant.
CREATE OR REPLACE FUNCTION public.ofoq_has_canonical_escalate()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS p
    JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'ofoq_client_escalate'
      AND p.pronargs = 9
      AND p.proargnames @> ARRAY[
        'p_conversation_id', 'p_category', 'p_severity',
        'p_title_ar', 'p_title_en', 'p_body_ar', 'p_body_en',
        'p_reason', 'p_signals'
      ]::text[]
  );
$function$;

REVOKE ALL ON FUNCTION public.ofoq_has_canonical_escalate() FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 2. The 4-argument overload: same escalation, fewer keys to type
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ofoq_client_escalate(
  p_conversation_id text,
  p_reason text DEFAULT 'HUMAN_REQUEST',
  p_summary text DEFAULT NULL,
  p_severity text DEFAULT 'IMPORTANT'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_identity text := coalesce(nullif(trim(p_reason), ''), 'HUMAN_REQUEST');
  v_category text;
  v_severity text;
  v_reason text;
  v_signals text := 'manual_sql_editor';
  v_summary text := nullif(trim(coalesce(p_summary, '')), '');
  v_title_ar text := 'عميل جديد يطلب تواصل';
  v_title_en text := 'New client requesting contact';
  v_label_ar text;
  v_label_en text;
  v_body_ar text;
  v_body_en text;
  v_conversation_id text := nullif(trim(coalesce(p_conversation_id, '')), '');
  v_result jsonb;
  v_now text := to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  -- The canonical function is the only writer of alerts. Say so, precisely,
  -- rather than failing inside the delegation with a second 42883.
  IF NOT public.ofoq_has_canonical_escalate() THEN
    RAISE EXCEPTION
      'The nine-argument public.ofoq_client_escalate is not installed; apply db/migrations/supabase/0004_escalation_owner_support.sql (or the whole docs/setup/supabase-setup.sql bundle) before using this overload'
      USING ERRCODE = '42883', HINT = 'SELECT pg_get_function_arguments(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = ''public'' AND p.proname = ''ofoq_client_escalate'';';
  END IF;

  IF v_conversation_id IS NULL THEN
    RAISE EXCEPTION 'p_conversation_id is required' USING ERRCODE = '22023';
  END IF;

  -- `p_reason` is the category in this overload. An unknown word here is kept
  -- for the audit trail instead of being rejected: a manual test should not
  -- fail on vocabulary, and `alerts.meta` records what was actually passed.
  v_category := upper(v_identity);
  IF v_category NOT IN ('HUMAN_REQUEST', 'NEW_LEAD') THEN
    v_reason := left(v_identity, 500);
    v_category := 'HUMAN_REQUEST';
  ELSE
    v_reason := 'manual ofoq_client_escalate(4-arg) call from the Supabase SQL Editor';
  END IF;

  -- Same allow-list as the canonical function, checked here so the message
  -- names THIS argument instead of surfacing as an alerts CHECK violation.
  v_severity := upper(coalesce(nullif(trim(p_severity), ''), 'IMPORTANT'));
  IF v_severity NOT IN ('URGENT', 'IMPORTANT') THEN
    RAISE EXCEPTION 'Unknown escalation severity "%" — expected URGENT or IMPORTANT', v_severity
      USING ERRCODE = '22023';
  END IF;

  -- Labels and titles match ESCALATION_CATEGORY_LABELS / ESCALATION_TITLES in
  -- src/lib/agents/escalation-agent.ts, so a hand-raised alert is
  -- indistinguishable from one the assistant raised.
  IF v_category = 'HUMAN_REQUEST' THEN
    v_label_ar := 'طلب فريق بشري';
    v_label_en := 'Human handoff';
  ELSE
    v_label_ar := 'طلب جديد';
    v_label_en := 'New lead';
  END IF;

  -- Body shape mirrors summariseConversation(): [label] reason, blank line,
  -- then the summary. 1400 chars is that module's MAX_BODY_LENGTH.
  v_body_ar := left(
    '[' || v_label_ar || '] ' ||
      CASE WHEN v_category = 'HUMAN_REQUEST'
        THEN 'العميل طلب التواصل مع فريق بشري'
        ELSE 'اكتمل فهم احتياج العميل'
      END ||
      chr(10) || chr(10) || coalesce(v_summary, 'طلب العميل التواصل مع فريق بشري.'),
    1400
  );
  v_body_en := left(
    '[' || v_label_en || '] ' ||
      CASE WHEN v_category = 'HUMAN_REQUEST'
        THEN 'The client asked to speak with a human team member'
        ELSE 'The client brief is understood'
      END ||
      chr(10) || chr(10) || coalesce(v_summary, 'Client requested human support.'),
    1400
  );

  -- Delegation is POSITIONAL on purpose: nine arguments can only match the
  -- canonical function, so this overload can never resolve to itself.
  v_result := public.ofoq_client_escalate(
    v_conversation_id, -- p_conversation_id
    v_category,        -- p_category
    v_severity,        -- p_severity
    v_title_ar,        -- p_title_ar
    v_title_en,        -- p_title_en
    v_body_ar,         -- p_body_ar
    v_body_en,         -- p_body_en
    v_reason,          -- p_reason
    v_signals          -- p_signals
  );

  -- Everything the service contract needs (alertId, created, staff,
  -- clientName, clientEmail, conversationStatus, identity) comes from the
  -- canonical result untouched; the keys below are the ones a manual reader
  -- asks for.
  RETURN coalesce(v_result, '{}'::jsonb) || jsonb_build_object(
    'ok', v_result IS NOT NULL,
    'alertId', v_result ->> 'alertId',
    'conversationId', v_conversation_id,
    'customerId', v_result -> 'identity' ->> 'customerId',
    'timestamp', v_now,
    'via', '4-arg overload → ofoq_client_escalate(p_conversation_id, p_category, p_severity, p_title_ar, p_title_en, p_body_ar, p_body_en, p_reason, p_signals)'
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.ofoq_client_escalate(text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ofoq_client_escalate(text, text, text, text) TO authenticated;

-- -----------------------------------------------------------------------------
-- 3. Re-assert the canonical grant, and report the state of the project
-- -----------------------------------------------------------------------------
-- Guarded so this file can be applied to a project that never received 0004
-- without aborting the whole transaction: `REVOKE … (text × 9)` would itself
-- fail with 42883 there, which is the exact error this migration is about.
DO $grants$
BEGIN
  IF public.ofoq_has_canonical_escalate() THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.ofoq_client_escalate(text, text, text, text, text, text, text, text, text) FROM PUBLIC, anon';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.ofoq_client_escalate(text, text, text, text, text, text, text, text, text) TO authenticated';
    RAISE NOTICE 'ofoq: ofoq_client_escalate is callable with 4 arguments (manual tests) and with 9 (the application)';
  ELSE
    RAISE WARNING
      'ofoq: the nine-argument public.ofoq_client_escalate is MISSING. The 4-argument overload was installed but will report 42883 until 0004 is applied — so the application''s own escalation is still broken on this project.';
  END IF;
END
$grants$;

-- One glance is enough to know what a project has. Run the same SELECT outside
-- a migration to re-check at any time.
DO $report$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_arguments(p.oid) || ')' AS signature
    FROM pg_proc AS p
    JOIN pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'ofoq_client_escalate',
        'ofoq_escalation_email_result',
        'ofoq_escalation_diagnostics',
        'ofoq_ensure_customer_profile'
      )
    ORDER BY p.proname, pg_get_function_arguments(p.oid)
  LOOP
    RAISE NOTICE 'ofoq: %', r.signature;
  END LOOP;
END
$report$;

-- -----------------------------------------------------------------------------
-- 4. Smoke test — read the note about auth.uid() before running it
-- -----------------------------------------------------------------------------
-- Both overloads resolve the caller with `(SELECT auth.uid())::text` and raise
-- 28000 when there is no session. The SQL Editor has no JWT, so a bare
--
--     SELECT public.ofoq_client_escalate('<conversation>', 'HUMAN_REQUEST', 'test', 'URGENT');
--
-- answers «Authentication required or account inactive». That is the function
-- working as designed, not a missing grant. To test by hand, give the session a
-- user first and roll the write back:
--
--   BEGIN;
--     SET LOCAL request.jwt.claims = '{"sub":"<users.id of an ACTIVE account>","role":"authenticated"}';
--
--     -- who is this account, and can it escalate?
--     SELECT public.ofoq_escalation_diagnostics();
--
--     -- the 4-argument overload added by this file
--     SELECT public.ofoq_client_escalate(
--       '<conversation.id, channel WEB>',
--       'HUMAN_REQUEST',
--       'اختبار يدوي من SQL Editor',
--       'URGENT'
--     );
--   ROLLBACK;
--
-- `SET LOCAL` only survives inside an open transaction. If the editor is set to
-- run each statement separately, use `SET request.jwt.claims = …` instead and
-- `RESET request.jwt.claims;` when finished — otherwise the GUC is dropped
-- before the SELECT runs and the call answers 28000 again.
--
-- `<users.id>` may be an OWNER: since 0004 any active OWNER/PARTNER may escalate
-- any WEB conversation. To find both ids in one go:
--
--   SELECT c.id AS conversation_id, c.customer_id, cu.user_id, u.email, u.role, u.status
--   FROM public.conversations AS c
--   LEFT JOIN public.customers AS cu ON cu.id = c.customer_id
--   LEFT JOIN public.users AS u ON u.id = cu.user_id
--   WHERE c.channel = 'WEB'
--   ORDER BY c.updated_at DESC
--   LIMIT 5;
--
-- An end-to-end check without SQL at all: sign in, tell the assistant
-- «أريد التحدث مع شخص حقيقي», and expect «✔ تم تحويل محادثتك…» plus a row in
-- /admin → أحدث الطلبات. `created: false` in the RPC result means an alert for
-- this conversation and category already exists today — that is the dedupe, and
-- it is the reason the smoke test above must run inside a rolled-back
-- transaction if you want the daily limit to stay untouched.

-- Supabase Auth, portal RPCs, RLS/column privileges and platform logs.
-- Source: db/migrations/supabase/0007_admin_alerts.sql.
-- =============================================================================
-- Ofoq admin alert centre
-- -----------------------------------------------------------------------------
-- Staff-only, auditable alert read/write RPCs used by /admin/alerts.
--
-- Direct access to public.alerts, conversations and messages remains revoked
-- for authenticated browser sessions. These SECURITY DEFINER functions always
-- re-check ofoq_is_staff(), bind writes to auth.uid(), and return only the
-- precise JSON shapes the admin UI needs.
--
-- Apply after 0001_auth_portal.sql and the escalation migrations.
-- Re-runnable by design: CREATE OR REPLACE only.
--
-- This file also verifies itself: block 0 reports what the project already has
-- and block 5 reports what it has now plus asks PostgREST to reload its schema
-- cache. That last step is what fixes «the RPC works in the SQL Editor but the
-- site answers PGRST202 — Could not find the function … in the schema cache».
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0. Pre-flight: which of these five functions does the project already have?
-- -----------------------------------------------------------------------------
-- Runs BEFORE the definitions on purpose: if a CREATE OR REPLACE below aborts
-- (PostgreSQL refuses to rename an existing input parameter, for example), the
-- output already shows the signature that caused it. Warnings are not errors —
-- this block never blocks the migration.
DO $ofoq_alerts_preflight$
DECLARE
  r record;
  v_found integer := 0;
  v_dropped integer := 0;
  v_expected text[];
BEGIN
  FOR r IN
    SELECT p.proname::text AS proname,
           p.oid::regprocedure::text AS signature,
           pg_get_function_identity_arguments(p.oid) AS identity_args,
           coalesce(p.proargnames, ARRAY[]::text[]) AS arg_names
    FROM pg_catalog.pg_proc AS p
    JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname::text IN (
        'ofoq_admin_alerts',
        'ofoq_admin_alert_details',
        'ofoq_admin_acknowledge_alert',
        'ofoq_admin_resolve_alert',
        'ofoq_admin_reply_to_client'
      )
    ORDER BY p.proname::text, p.oid::regprocedure::text
  LOOP
    v_found := v_found + 1;
    RAISE NOTICE 'ofoq: already installed — % [args: %]', r.signature, array_to_string(r.arg_names, ', ');

    -- The exact argument list the application sends, including the types, i.e.
    -- the string DROP FUNCTION needs.
    -- Matched on proname, not on the rendered signature: `regprocedure` drops
    -- the schema only when the function happens to be in search_path, so
    -- `signature LIKE 'ofoq_…'` is not reliable.
    v_expected := CASE r.proname
      WHEN 'ofoq_admin_alerts' THEN ARRAY['p_status text, p_limit integer, p_offset integer']::text[]
      WHEN 'ofoq_admin_alert_details' THEN ARRAY['p_alert_id text']::text[]
      WHEN 'ofoq_admin_acknowledge_alert' THEN ARRAY['p_alert_id text']::text[]
      WHEN 'ofoq_admin_resolve_alert' THEN ARRAY['p_alert_id text, p_note text']::text[]
      WHEN 'ofoq_admin_reply_to_client' THEN ARRAY['p_alert_id text, p_body text, p_language text']::text[]
      ELSE NULL
    END;

    -- PostgREST resolves an RPC by name AND parameter names, so a function the
    -- SQL Editor reaches positionally can still be invisible to the app:
    -- `SELECT ofoq_admin_alert_details('<id>')` works while
    -- `rpc('ofoq_admin_alert_details', { p_alert_id })` answers PGRST202
    -- «Could not find the function … in the schema cache». A mismatched
    -- overload ALSO makes `CREATE OR REPLACE` below abort with
    -- «cannot change name of input parameter», which would leave the whole
    -- file half-applied — so the non-canonical signature is removed here,
    -- loudly, and only ever the ones with a different argument list.
    IF v_expected IS NOT NULL AND r.identity_args IS DISTINCT FROM v_expected[1] THEN
      BEGIN
        -- %I takes the NAME only; the argument list comes from
        -- pg_get_function_identity_arguments(), which is exactly the text
        -- DROP FUNCTION needs (types, with the parameter names PostgreSQL
        -- itself prints).
        EXECUTE format('DROP FUNCTION public.%I(%s)', r.proname, r.identity_args);
        v_dropped := v_dropped + 1;
        RAISE WARNING
          'ofoq: removed % — the application calls this action with (%) and PostgREST matches parameter names. The canonical definition is created below.',
          r.signature, v_expected[1];
      EXCEPTION
        WHEN OTHERS THEN
          RAISE WARNING
            'ofoq: % exists with the argument list (%) instead of (%), and it could not be dropped automatically (%). It MUST be dropped by hand before this file can apply.',
            r.signature, r.identity_args, v_expected[1], SQLERRM;
      END;
    END IF;
  END LOOP;
  IF v_found = 0 THEN
    RAISE NOTICE 'ofoq: none of the admin alert RPCs exist yet — this file installs them now.';
  ELSIF v_dropped > 0 THEN
    RAISE NOTICE 'ofoq: % non-canonical signature(s) were removed so the definitions below can be installed.', v_dropped;
  END IF;
END
$ofoq_alerts_preflight$;

-- All staff-facing alert rows, with a bounded page. OPEN is NEW + ACKNOWLEDGED.
CREATE OR REPLACE FUNCTION public.ofoq_admin_alerts(
  p_status text DEFAULT 'ALL',
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_status text := upper(coalesce(trim(p_status), 'ALL'));
  v_limit integer := greatest(1, least(coalesce(p_limit, 50), 100));
  v_offset integer := greatest(0, least(coalesce(p_offset, 0), 10000));
  v_items jsonb;
  v_total bigint;
BEGIN
  IF NOT public.ofoq_is_staff() THEN
    RAISE EXCEPTION 'Staff access required' USING ERRCODE = '42501';
  END IF;

  IF v_status NOT IN ('OPEN', 'ALL', 'NEW', 'ACKNOWLEDGED', 'RESOLVED') THEN
    RAISE EXCEPTION 'Unknown alert status filter' USING ERRCODE = '22023';
  END IF;

  SELECT count(*) INTO v_total
  FROM public.alerts AS a
  WHERE a.target_role <> 'CLIENT'
    AND (
      v_status = 'ALL'
      OR (v_status = 'OPEN' AND a.status IN ('NEW', 'ACKNOWLEDGED'))
      OR (v_status = 'NEW' AND a.status = 'NEW')
      OR (v_status = 'ACKNOWLEDGED' AND a.status = 'ACKNOWLEDGED')
      OR (v_status = 'RESOLVED' AND a.status = 'RESOLVED')
    );

  SELECT coalesce(jsonb_agg(item ORDER BY created_at DESC), '[]'::jsonb) INTO v_items
  FROM (
    SELECT a.created_at,
      jsonb_build_object(
        'id', a.id,
        'severity', a.severity,
        'category', a.category,
        'titleAr', a.title_ar,
        'titleEn', a.title_en,
        'bodyAr', a.body_ar,
        'bodyEn', a.body_en,
        'status', a.status,
        'createdAt', a.created_at,
        'updatedAt', a.updated_at,
        'customerName', c.contact_name,
        'customerEmail', c.email,
        'conversationId', CASE WHEN a.entity_type = 'conversation' THEN a.entity_id ELSE NULL END
      ) AS item
    FROM public.alerts AS a
    LEFT JOIN public.customers AS c ON c.id = a.customer_id
    WHERE a.target_role <> 'CLIENT'
      AND (
        v_status = 'ALL'
        OR (v_status = 'OPEN' AND a.status IN ('NEW', 'ACKNOWLEDGED'))
        OR (v_status = 'NEW' AND a.status = 'NEW')
        OR (v_status = 'ACKNOWLEDGED' AND a.status = 'ACKNOWLEDGED')
        OR (v_status = 'RESOLVED' AND a.status = 'RESOLVED')
      )
    ORDER BY a.created_at DESC
    LIMIT v_limit OFFSET v_offset
  ) AS listed;

  RETURN jsonb_build_object(
    'items', v_items,
    'total', v_total,
    'filter', v_status,
    'limit', v_limit,
    'offset', v_offset
  );
END;
$function$;

-- One alert plus the real client/conversation context that explains it.
CREATE OR REPLACE FUNCTION public.ofoq_admin_alert_details(p_alert_id text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_alert jsonb;
  v_client jsonb;
  v_conversation jsonb;
  v_messages jsonb;
  v_activities jsonb;
BEGIN
  IF NOT public.ofoq_is_staff() THEN
    RAISE EXCEPTION 'Staff access required' USING ERRCODE = '42501';
  END IF;
  IF p_alert_id IS NULL OR length(trim(p_alert_id)) = 0 OR length(p_alert_id) > 200 THEN
    RAISE EXCEPTION 'A valid alert id is required' USING ERRCODE = '22023';
  END IF;

  SELECT jsonb_build_object(
    'id', a.id,
    'severity', a.severity,
    'category', a.category,
    'titleAr', a.title_ar,
    'titleEn', a.title_en,
    'bodyAr', a.body_ar,
    'bodyEn', a.body_en,
    'status', a.status,
    'createdAt', a.created_at,
    'updatedAt', a.updated_at,
    'customerName', c.contact_name,
    'customerEmail', c.email,
    'conversationId', CASE WHEN a.entity_type = 'conversation' THEN a.entity_id ELSE NULL END,
    'entityType', a.entity_type,
    'entityId', a.entity_id,
    'targetRole', a.target_role,
    'acknowledgedAt', a.acknowledged_at,
    'acknowledgedBy', u.name,
    'resolvedAt', a.resolved_at,
    -- Resolution notes are logged in the append-only activity trail rather
    -- than overwritten on the alert row. This exposes the latest one plainly.
    'resolutionNote', (
      SELECT nullif(ac.summary, 'Alert resolved')
      FROM public.activities AS ac
      WHERE ac.entity_type = 'alert' AND ac.entity_id = a.id AND ac.action = 'alert.resolved'
      ORDER BY ac.created_at DESC
      LIMIT 1
    )
  ) INTO v_alert
  FROM public.alerts AS a
  LEFT JOIN public.customers AS c ON c.id = a.customer_id
  LEFT JOIN public.users AS u ON u.id = a.acknowledged_by_user_id
  WHERE a.id = trim(p_alert_id) AND a.target_role <> 'CLIENT';

  IF v_alert IS NULL THEN
    RAISE EXCEPTION 'Alert not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT jsonb_build_object(
    'id', c.id,
    'name', c.contact_name,
    'companyName', c.company_name,
    'email', c.email,
    'phone', c.phone
  ) INTO v_client
  FROM public.alerts AS a
  JOIN public.customers AS c ON c.id = a.customer_id
  WHERE a.id = trim(p_alert_id);

  SELECT jsonb_build_object(
    'id', co.id,
    'subject', co.subject,
    'status', co.status,
    'lastMessageAt', co.last_message_at
  ) INTO v_conversation
  FROM public.alerts AS a
  JOIN public.conversations AS co ON co.id = a.entity_id
  WHERE a.id = trim(p_alert_id) AND a.entity_type = 'conversation';

  SELECT coalesce(jsonb_agg(item ORDER BY created_at ASC), '[]'::jsonb) INTO v_messages
  FROM (
    SELECT m.created_at,
      jsonb_build_object(
        'id', m.id,
        'sender', m.sender_type,
        'senderLabel', m.sender_label,
        'body', m.body,
        'language', m.language,
        'createdAt', m.created_at
      ) AS item
    FROM public.alerts AS a
    JOIN public.messages AS m ON m.conversation_id = a.entity_id
    WHERE a.id = trim(p_alert_id) AND a.entity_type = 'conversation'
    ORDER BY m.created_at DESC
    LIMIT 100
  ) AS recent_messages;

  SELECT coalesce(jsonb_agg(item ORDER BY created_at DESC), '[]'::jsonb) INTO v_activities
  FROM (
    SELECT ac.created_at,
      jsonb_build_object(
        'id', ac.id,
        'action', ac.action,
        'actorType', ac.actor_type,
        'actorLabel', ac.actor_label,
        'summary', ac.summary,
        'createdAt', ac.created_at
      ) AS item
    FROM public.activities AS ac
    WHERE ac.entity_type = 'alert' AND ac.entity_id = trim(p_alert_id)
    ORDER BY ac.created_at DESC
    LIMIT 30
  ) AS recent_activities;

  RETURN jsonb_build_object(
    'alert', v_alert,
    'client', v_client,
    'conversation', v_conversation,
    'messages', v_messages,
    'activities', v_activities
  );
END;
$function$;

-- Claim an alert for the current staff member. Repeated clicks are idempotent.
CREATE OR REPLACE FUNCTION public.ofoq_admin_acknowledge_alert(p_alert_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_user_id text := (SELECT auth.uid())::text;
  v_name text;
  v_status text;
  v_customer_id text;
  v_now text := to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  IF NOT public.ofoq_is_staff() OR v_user_id IS NULL THEN
    RAISE EXCEPTION 'Staff access required' USING ERRCODE = '42501';
  END IF;

  SELECT a.status, a.customer_id, u.name
  INTO v_status, v_customer_id, v_name
  FROM public.alerts AS a
  JOIN public.users AS u ON u.id = v_user_id
  WHERE a.id = trim(coalesce(p_alert_id, '')) AND a.target_role <> 'CLIENT';

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'Alert not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_status = 'RESOLVED' THEN
    RETURN public.ofoq_admin_alert_details(p_alert_id);
  END IF;

  IF v_status = 'NEW' THEN
    UPDATE public.alerts
    SET status = 'ACKNOWLEDGED',
        acknowledged_by_user_id = v_user_id,
        acknowledged_at = v_now,
        updated_at = v_now
    WHERE id = trim(p_alert_id);

    INSERT INTO public.activities
      (id, actor_type, actor_user_id, actor_label, action, entity_type, entity_id,
       customer_id, summary, meta, is_demo, created_at)
    VALUES
      (gen_random_uuid()::text, 'USER', v_user_id, coalesce(v_name, 'Ofoq staff'),
       'alert.acknowledged', 'alert', trim(p_alert_id), v_customer_id,
       'Alert acknowledged', jsonb_build_object('alertId', trim(p_alert_id))::text, 0, v_now);
  END IF;

  RETURN public.ofoq_admin_alert_details(p_alert_id);
END;
$function$;

-- Resolve an alert and preserve the operator note in its immutable activity trail.
CREATE OR REPLACE FUNCTION public.ofoq_admin_resolve_alert(
  p_alert_id text,
  p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_user_id text := (SELECT auth.uid())::text;
  v_name text;
  v_status text;
  v_customer_id text;
  v_note text := nullif(trim(coalesce(p_note, '')), '');
  v_now text := to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  IF NOT public.ofoq_is_staff() OR v_user_id IS NULL THEN
    RAISE EXCEPTION 'Staff access required' USING ERRCODE = '42501';
  END IF;
  IF length(coalesce(p_note, '')) > 2000 THEN
    RAISE EXCEPTION 'Resolution note is too long' USING ERRCODE = '22023';
  END IF;

  SELECT a.status, a.customer_id, u.name
  INTO v_status, v_customer_id, v_name
  FROM public.alerts AS a
  JOIN public.users AS u ON u.id = v_user_id
  WHERE a.id = trim(coalesce(p_alert_id, '')) AND a.target_role <> 'CLIENT';

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'Alert not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_status <> 'RESOLVED' THEN
    UPDATE public.alerts
    SET status = 'RESOLVED',
        resolved_at = v_now,
        updated_at = v_now
    WHERE id = trim(p_alert_id);

    INSERT INTO public.activities
      (id, actor_type, actor_user_id, actor_label, action, entity_type, entity_id,
       customer_id, summary, meta, is_demo, created_at)
    VALUES
      (gen_random_uuid()::text, 'USER', v_user_id, coalesce(v_name, 'Ofoq staff'),
       'alert.resolved', 'alert', trim(p_alert_id), v_customer_id,
       CASE WHEN v_note IS NULL THEN 'Alert resolved' ELSE 'Alert resolved: ' || v_note END,
       jsonb_build_object('alertId', trim(p_alert_id), 'note', v_note)::text, 0, v_now);
  END IF;

  RETURN public.ofoq_admin_alert_details(p_alert_id);
END;
$function$;

-- Send a human reply into the client conversation linked to an alert.
CREATE OR REPLACE FUNCTION public.ofoq_admin_reply_to_client(
  p_alert_id text,
  p_body text,
  p_language text DEFAULT 'ar'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_user_id text := (SELECT auth.uid())::text;
  v_name text;
  v_alert_status text;
  v_customer_id text;
  v_conversation_id text;
  v_message_id text := gen_random_uuid()::text;
  v_language text := CASE WHEN p_language = 'en' THEN 'en' ELSE 'ar' END;
  v_body text := nullif(trim(coalesce(p_body, '')), '');
  v_now text := to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  IF NOT public.ofoq_is_staff() OR v_user_id IS NULL THEN
    RAISE EXCEPTION 'Staff access required' USING ERRCODE = '42501';
  END IF;
  IF v_body IS NULL OR length(coalesce(p_body, '')) > 5000 THEN
    RAISE EXCEPTION 'Reply must contain between 1 and 5000 characters' USING ERRCODE = '22023';
  END IF;

  SELECT a.status, a.customer_id, a.entity_id, u.name
  INTO v_alert_status, v_customer_id, v_conversation_id, v_name
  FROM public.alerts AS a
  JOIN public.users AS u ON u.id = v_user_id
  WHERE a.id = trim(coalesce(p_alert_id, ''))
    AND a.target_role <> 'CLIENT'
    AND a.entity_type = 'conversation';

  IF v_alert_status IS NULL THEN
    RAISE EXCEPTION 'Alert is not linked to a client conversation' USING ERRCODE = 'P0002';
  END IF;

  -- The alert/customer link must agree with the conversation when the alert
  -- carries a customer id. Null remains allowed for legacy owner escalations.
  IF NOT EXISTS (
    SELECT 1 FROM public.conversations AS c
    WHERE c.id = v_conversation_id
      AND (v_customer_id IS NULL OR c.customer_id = v_customer_id)
  ) THEN
    RAISE EXCEPTION 'Conversation not found for this alert' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.messages
    (id, conversation_id, sender_type, sender_user_id, sender_label, body,
     language, meta, created_at, is_demo)
  VALUES
    (v_message_id, v_conversation_id, 'STAFF', v_user_id, coalesce(v_name, 'فريق أفق'),
     v_body, v_language, jsonb_build_object('source', 'admin-alert-centre', 'alertId', trim(p_alert_id))::text,
     v_now, 0);

  UPDATE public.conversations
  SET status = 'OPEN',
      unread_for_client = unread_for_client + 1,
      unread_for_staff = 0,
      last_message_at = v_now,
      updated_at = v_now
  WHERE id = v_conversation_id;

  -- Replying is an acknowledgement if nobody has claimed the alert yet.
  IF v_alert_status = 'NEW' THEN
    UPDATE public.alerts
    SET status = 'ACKNOWLEDGED',
        acknowledged_by_user_id = v_user_id,
        acknowledged_at = v_now,
        updated_at = v_now
    WHERE id = trim(p_alert_id);
  END IF;

  INSERT INTO public.activities
    (id, actor_type, actor_user_id, actor_label, action, entity_type, entity_id,
     customer_id, summary, meta, is_demo, created_at)
  VALUES
    (gen_random_uuid()::text, 'USER', v_user_id, coalesce(v_name, 'Ofoq staff'),
     'alert.replied_to_client', 'alert', trim(p_alert_id), v_customer_id,
     'Reply sent to client',
     jsonb_build_object('alertId', trim(p_alert_id), 'conversationId', v_conversation_id, 'messageId', v_message_id)::text,
     0, v_now);

  RETURN public.ofoq_admin_alert_details(p_alert_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.ofoq_admin_alerts(text, integer, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ofoq_admin_alert_details(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ofoq_admin_acknowledge_alert(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ofoq_admin_resolve_alert(text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ofoq_admin_reply_to_client(text, text, text) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.ofoq_admin_alerts(text, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ofoq_admin_alert_details(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ofoq_admin_acknowledge_alert(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ofoq_admin_resolve_alert(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ofoq_admin_reply_to_client(text, text, text) TO authenticated;

-- -----------------------------------------------------------------------------
-- 5. Verification, and the PostgREST schema-cache reload
-- -----------------------------------------------------------------------------
-- Why this is here
-- ----------------
-- Installing the functions is not enough for the Data API. The classic report —
-- «the RPC returns data in the SQL Editor, but /admin/alerts/[id] says the
-- migration is not installed yet» — is this error from PostgREST:
--
--     PGRST202: Could not find the function
--               public.ofoq_admin_alert_details(p_alert_id) in the schema cache
--
-- The function can exist and be callable while PostgREST's cached description
-- of the schema predates it (or describes another project's). NOTIFY asks the
-- API to reload that cache right away; Supabase's dashboard → Settings → API →
-- «Reload schema» does the same thing by hand.
--
-- The verification block below then reports, in the SQL Editor output, exactly
-- which of the five functions this project now has and whether the
-- `authenticated` role may execute each one — the same facts
-- GET /api/debug/alerts shows from the application side.
NOTIFY pgrst, 'reload schema';

DO $ofoq_alerts_verify$
DECLARE
  r record;
  v_expected record;
  v_missing text[] := ARRAY[]::text[];
  v_installed integer := 0;
BEGIN
  FOR v_expected IN
    SELECT * FROM (VALUES
      ('ofoq_admin_alerts', ARRAY['p_status', 'p_limit', 'p_offset']::text[]),
      ('ofoq_admin_alert_details', ARRAY['p_alert_id']::text[]),
      ('ofoq_admin_acknowledge_alert', ARRAY['p_alert_id']::text[]),
      ('ofoq_admin_resolve_alert', ARRAY['p_alert_id', 'p_note']::text[]),
      ('ofoq_admin_reply_to_client', ARRAY['p_alert_id', 'p_body', 'p_language']::text[])
    ) AS expected(proname, args)
  LOOP
    SELECT p.oid::regprocedure::text AS signature,
           coalesce(p.proargnames, ARRAY[]::text[]) AS arg_names,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') AS executable
      INTO r
    FROM pg_catalog.pg_proc AS p
    JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname::text = v_expected.proname
      AND coalesce(p.proargnames, ARRAY[]::text[]) = v_expected.args
    LIMIT 1;

    IF r IS NULL THEN
      v_missing := v_missing || v_expected.proname;
      RAISE NOTICE 'ofoq: ✗ % (%) is NOT installed with the argument names the app sends',
        v_expected.proname, array_to_string(v_expected.args, ', ');
    ELSE
      v_installed := v_installed + 1;
      RAISE NOTICE 'ofoq: ✓ % — executable by authenticated: %',
        r.signature, r.executable;
    END IF;
  END LOOP;

  IF array_length(v_missing, 1) > 0 THEN
    RAISE WARNING
      'ofoq: the alert centre will keep answering «Supabase portal migration is not installed yet» until these are fixed: %. Open <site>/api/debug/alerts while signed in for the API-side view, and check that NEXT_PUBLIC_SUPABASE_URL points at THIS project.',
      array_to_string(v_missing, ', ');
  ELSE
    RAISE NOTICE 'ofoq: all % admin alert RPCs are installed with the expected signatures; the Data API was asked to reload its schema cache.', v_installed;
  END IF;
END
$ofoq_alerts_verify$;

-- Supabase Auth, portal RPCs, RLS/column privileges and platform logs.
-- Source: db/migrations/supabase/0008_service_requests.sql.
-- =============================================================================
-- Ofoq guided service requests
-- -----------------------------------------------------------------------------
-- The assistant's guided request (type → size → budget → target area →
-- contact channel) ends in /api/chat/service-request, which calls the single
-- RPC defined here. In ONE transaction it:
--
--   1. resolves the signed-in client (creating the missing `customers` row
--      through ofoq_ensure_customer_profile(), exactly like the chat does);
--   2. issues the order reference  OFOQ-<year>-<sequence>  (001, 002, …);
--   3. inserts the `offers` row — status DRAFT (see the note below);
--   4. inserts the /admin/alerts entry: severity IMPORTANT, category
--      NEW_REQUEST, title «طلب خدمة جديد #<order>», the whole request in the
--      body (channel, the WhatsApp number as typed and the wa.me link when
--      WhatsApp was chosen) and the structured details in `meta`;
--   5. notifies every active OWNER/PARTNER (IN_APP sent, EMAIL queued) and
--      writes the activity row.
--
-- It is deliberately NOT ofoq_client_escalate(): that function is the human
-- handoff (HUMAN_REQUEST / URGENT) and refuses any other category. A new
-- request is not a handoff — it must never be raised through that path.
--
-- Idempotent per request: the browser sends a `requestId`; a retry with the
-- same id returns the rows already written instead of a second order.
--
-- Status note (the Supabase «PR #2»): the `offers.status` CHECK of the
-- generated schema allows DRAFT / SENT / APPROVED / REJECTED / EXPIRED /
-- CANCELLED only. REQUESTED is the intended status for these rows, but an
-- insert with it fails the CHECK, so this function writes DRAFT and tags the
-- row (`pricing_breakdown.source = guided_service_request`). The CHECK is
-- widened by db/migrations/supabase/pending/0009_offers_requested_status.sql,
-- which is applied separately; `SERVICE_REQUEST_OFFER_STATUS` in
-- src/lib/services/service-requests.service.ts is the one constant to flip.
--
-- Apply after 0001_auth_portal.sql and 0004_escalation_owner_support.sql.
-- Re-runnable by design: CREATE OR REPLACE only.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.ofoq_client_service_request(
  p_request_id text,
  p_title_ar text,
  p_title_en text,
  p_body_ar text,
  p_body_en text,
  p_offer jsonb,
  p_contact jsonb,
  p_meta jsonb DEFAULT '{}'::jsonb,
  p_conversation_id text DEFAULT NULL,
  p_locale text DEFAULT 'ar'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_user_id text := (SELECT auth.uid())::text;
  v_role text;
  v_customer_id text;
  v_customer_phone text;
  v_request_id text := nullif(trim(coalesce(p_request_id, '')), '');
  v_dedupe_key text;
  v_existing_alert_id text;
  v_existing_meta jsonb;
  v_year text := to_char(timezone('utc', now()), 'YYYY');
  v_sequence integer;
  v_code text;
  v_offer_id text := gen_random_uuid()::text;
  v_alert_id text := gen_random_uuid()::text;
  v_status text := 'DRAFT';
  v_requested_status text := upper(coalesce(nullif(trim(p_offer ->> 'status'), ''), 'DRAFT'));
  v_total bigint := coalesce((p_offer ->> 'total_minor')::bigint, 0);
  v_subtotal bigint := coalesce((p_offer ->> 'subtotal_minor')::bigint, (p_offer ->> 'total_minor')::bigint, 0);
  v_channel text := lower(coalesce(nullif(trim(p_contact ->> 'channel'), ''), 'website'));
  v_contact_value text := nullif(trim(coalesce(p_contact ->> 'value', '')), '');
  v_whatsapp_number text := nullif(trim(coalesce(p_contact ->> 'whatsappNumber', '')), '');
  v_whatsapp_link text := nullif(trim(coalesce(p_contact ->> 'whatsappLink', '')), '');
  v_conversation_id text := NULL;
  v_entity_type text;
  v_entity_id text;
  v_title_ar text;
  v_title_en text;
  v_body_ar text;
  v_body_en text;
  v_meta jsonb;
  v_staff jsonb;
  v_now text := to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  -- Who is calling? Every account that can chat can send a request.
  SELECT u.role INTO v_role
  FROM public.users AS u
  WHERE u.id = v_user_id AND u.status = 'ACTIVE';

  IF v_user_id IS NULL OR v_role IS NULL THEN
    RAISE EXCEPTION 'Authentication required or account inactive' USING ERRCODE = '28000';
  END IF;

  IF v_request_id IS NULL OR length(v_request_id) < 8 THEN
    RAISE EXCEPTION 'A request id is required' USING ERRCODE = '22023';
  END IF;
  IF v_channel NOT IN ('whatsapp', 'email', 'website') THEN
    RAISE EXCEPTION 'Unknown contact channel' USING ERRCODE = '22023';
  END IF;
  IF v_channel = 'whatsapp' AND v_contact_value IS NULL THEN
    RAISE EXCEPTION 'A WhatsApp number is required' USING ERRCODE = '22023';
  END IF;
  -- Only the statuses the CHECK allows today; REQUESTED arrives with 0009.
  IF v_requested_status NOT IN ('DRAFT') THEN
    RAISE EXCEPTION 'Unsupported offer status % (apply pending/0009_offers_requested_status.sql first)', v_requested_status
      USING ERRCODE = '22023';
  END IF;

  -- The client record (created on the spot for accounts that predate the
  -- signup trigger, owners included).
  v_customer_id := public.ofoq_ensure_customer_profile();

  v_dedupe_key := 'service-request:' || v_request_id;

  -- Idempotency: the same browser request id returns what was already saved.
  SELECT a.id, coalesce(a.meta, '{}')::jsonb INTO v_existing_alert_id, v_existing_meta
  FROM public.alerts AS a
  WHERE a.dedupe_key = v_dedupe_key;

  IF v_existing_alert_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'requestId', v_request_id,
      'orderCode', v_existing_meta ->> 'orderCode',
      'offerId', v_existing_meta ->> 'offerId',
      'offerStatus', (SELECT o.status FROM public.offers AS o WHERE o.id = v_existing_meta ->> 'offerId'),
      'alertId', v_existing_alert_id,
      'created', false,
      'category', 'NEW_REQUEST',
      'severity', 'IMPORTANT'
    );
  END IF;

  -- The conversation is linked only when it really belongs to this client:
  -- the admin alert page then shows the chat next to the request.
  IF p_conversation_id IS NOT NULL AND length(trim(p_conversation_id)) > 0 THEN
    SELECT c.id INTO v_conversation_id
    FROM public.conversations AS c
    WHERE c.id = p_conversation_id AND c.customer_id = v_customer_id;
  END IF;

  -- Order reference: OFOQ-<year>-<sequence>, serialised so two clients cannot
  -- draw the same number.
  PERFORM pg_advisory_xact_lock(hashtext('ofoq_service_request_code'));
  SELECT coalesce(max(nullif(regexp_replace(o.code, '^OFOQ-' || v_year || '-', ''), '')::integer), 0) + 1
  INTO v_sequence
  FROM public.offers AS o
  WHERE o.code ~ ('^OFOQ-' || v_year || '-[0-9]+$');
  v_code := 'OFOQ-' || v_year || '-' || lpad(v_sequence::text, 3, '0');

  INSERT INTO public.offers
    (id, code, customer_id, project_id, status, currency,
     subtotal_minor, discount_minor, total_minor, internal_cost_minor, margin_pct,
     valid_until, pricing_reason, pricing_breakdown, client_note, internal_note,
     created_by_agent, created_by_user_id, approved_at, rejected_at, is_demo,
     created_at, updated_at)
  VALUES
    (v_offer_id, v_code, v_customer_id, NULL, v_status,
     coalesce(nullif(trim(p_offer ->> 'currency'), ''), 'USD'),
     v_subtotal, 0, v_total, 0, NULL,
     NULL,
     p_offer ->> 'pricing_reason',
     (coalesce(p_offer -> 'pricing_breakdown', '{}'::jsonb)
        || jsonb_build_object('orderCode', v_code, 'requestId', v_request_id, 'status', v_status))::text,
     p_offer ->> 'client_note',
     p_offer ->> 'internal_note',
     coalesce(nullif(trim(p_offer ->> 'created_by_agent'), ''), 'pricing-agent'),
     NULL, NULL, NULL, 0,
     v_now, v_now);

  -- The alert the team sees: the order in the title and on the first line.
  v_title_ar := coalesce(nullif(trim(p_title_ar), ''), 'طلب خدمة جديد') || ' #' || v_code;
  v_title_en := coalesce(nullif(trim(p_title_en), ''), 'New service request') || ' #' || v_code;
  v_body_ar := 'رقم الطلب: ' || v_code || E'\n' || coalesce(p_body_ar, '');
  v_body_en := 'Order reference: ' || v_code || E'\n' || coalesce(p_body_en, '');

  IF v_conversation_id IS NOT NULL THEN
    v_entity_type := 'conversation';
    v_entity_id := v_conversation_id;
  ELSE
    v_entity_type := 'service_request';
    v_entity_id := v_offer_id;
  END IF;

  v_meta := coalesce(p_meta, '{}'::jsonb)
    || jsonb_build_object(
         'source', 'guided_service_request',
         'requestId', v_request_id,
         'orderCode', v_code,
         'offerId', v_offer_id,
         'offerStatus', v_status,
         'conversationId', v_conversation_id,
         'customerId', v_customer_id,
         'contact', jsonb_build_object(
           'channel', v_channel,
           'value', v_contact_value,
           'whatsappNumber', v_whatsapp_number,
           'whatsappLink', v_whatsapp_link
         ),
         'whatsapp', CASE WHEN v_channel = 'whatsapp' THEN jsonb_build_object(
           'channel', 'واتساب',
           'number', v_contact_value,
           'international', v_whatsapp_number,
           'link', v_whatsapp_link
         ) ELSE NULL END,
         'raisedByRole', v_role,
         'raisedByUserId', v_user_id,
         'locale', coalesce(nullif(trim(p_locale), ''), 'ar')
       );

  INSERT INTO public.alerts
    (id, severity, category, title_ar, title_en, body_ar, body_en,
     entity_type, entity_id, customer_id, target_role, status,
     dedupe_key, meta, is_demo, created_at, updated_at)
  VALUES
    (v_alert_id, 'IMPORTANT', 'NEW_REQUEST', v_title_ar, v_title_en, v_body_ar, v_body_en,
     v_entity_type, v_entity_id, v_customer_id, 'ANY_STAFF', 'NEW',
     v_dedupe_key, v_meta::text, 0, v_now, v_now);

  -- The client's phone becomes known through the request.
  IF v_channel = 'whatsapp' THEN
    SELECT cu.phone INTO v_customer_phone FROM public.customers AS cu WHERE cu.id = v_customer_id;
    IF v_customer_phone IS NULL OR length(trim(v_customer_phone)) = 0 THEN
      UPDATE public.customers SET phone = v_contact_value, updated_at = v_now WHERE id = v_customer_id;
    END IF;
  END IF;

  -- Everyone who may act on it: active owners and partners.
  SELECT coalesce(
    jsonb_agg(jsonb_build_object('id', u.id, 'email', u.email, 'name', u.name) ORDER BY u.created_at),
    '[]'::jsonb
  )
  INTO v_staff
  FROM public.users AS u
  WHERE u.role IN ('OWNER', 'PARTNER') AND u.status = 'ACTIVE';

  INSERT INTO public.notifications (id, user_id, alert_id, channel, subject, body, status, created_at)
  SELECT gen_random_uuid()::text, s ->> 'id', v_alert_id, 'IN_APP', v_title_ar, v_body_ar, 'SENT', v_now
  FROM jsonb_array_elements(v_staff) AS s;

  INSERT INTO public.notifications (id, user_id, alert_id, channel, subject, body, status, created_at)
  SELECT gen_random_uuid()::text, s ->> 'id', v_alert_id, 'EMAIL', v_title_ar, v_body_ar, 'QUEUED', v_now
  FROM jsonb_array_elements(v_staff) AS s;

  INSERT INTO public.activities
    (id, actor_type, actor_label, action, entity_type, entity_id, customer_id,
     summary, meta, is_demo, created_at)
  VALUES
    (gen_random_uuid()::text, 'AGENT', 'pricing-agent', 'service_request.submitted',
     'service_request', v_offer_id, v_customer_id,
     v_title_ar,
     jsonb_build_object(
       'requestId', v_request_id,
       'orderCode', v_code,
       'offerId', v_offer_id,
       'offerStatus', v_status,
       'alertId', v_alert_id,
       'category', 'NEW_REQUEST',
       'severity', 'IMPORTANT',
       'contact', jsonb_build_object('channel', v_channel, 'value', v_contact_value, 'whatsappLink', v_whatsapp_link),
       'conversationId', v_conversation_id,
       'raisedByRole', v_role
     )::text,
     0, v_now);

  RETURN jsonb_build_object(
    'requestId', v_request_id,
    'orderCode', v_code,
    'offerId', v_offer_id,
    'offerStatus', v_status,
    'alertId', v_alert_id,
    'created', true,
    'category', 'NEW_REQUEST',
    'severity', 'IMPORTANT',
    'conversationId', v_conversation_id,
    'customerId', v_customer_id,
    'staff', coalesce(v_staff, '[]'::jsonb)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.ofoq_client_service_request(text, text, text, text, text, jsonb, jsonb, jsonb, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ofoq_client_service_request(text, text, text, text, text, jsonb, jsonb, jsonb, text, text) TO authenticated;

-- PostgREST caches the schema: without this the site answers PGRST202
-- («Could not find the function … in the schema cache») although the SQL
-- Editor sees the function.
NOTIFY pgrst, 'reload schema';

-- Supabase Auth, portal RPCs, RLS/column privileges and platform logs.
-- Source: db/migrations/supabase/0010_harden_service_requests_and_offer_access.sql.
-- =============================================================================
-- Ofoq — harden guided service-request pricing and offer access.
-- -----------------------------------------------------------------------------
-- This is a NEW migration. Do not edit/re-run an older migration in production.
-- It does not activate pending/0009_offers_requested_status.sql and does not
-- update or delete existing offer rows.
--
-- Apply after the core schema, Supabase Auth portal objects, and migration
-- 0008_service_requests.sql, as the existing RPC owner (normally `postgres` in
-- Supabase SQL Editor). The preflight fails closed if required
-- tables/columns/functions are absent or if an unexpected overload exists;
-- inspect the target database before retrying.
--
-- Security guarantees for new requests:
--   * only validated request inputs are read from p_offer.pricing_breakdown;
--     caller-supplied total/subtotal/currency/reason/internal fields are ignored;
--   * the existing pricing-agent formulas are recomputed in PostgreSQL;
--   * an unpriced `other` request stores NULL money, never a fabricated amount;
--   * request dedupe keys are scoped to the authenticated user/customer;
--   * only a DB-owned private record can mark a newly calculated price trusted;
--   * no staff identities/emails are returned by the client-callable RPC;
--   * authenticated/anon clients have no direct SELECT on offers/offer_items;
--   * the client dashboard RPC is replaced so DRAFT offers (including the
--     guided service requests) are never returned to the client.
--
-- Existing DRAFT rows are deliberately not backfilled: the deployed database
-- and any previous direct-RPC use cannot be verified from this repository.
-- Such historical rows need a separate, owner-reviewed reconciliation.
-- =============================================================================

BEGIN;

DO $ofoq_service_request_security_preflight$
DECLARE
  v_missing text[];
  v_rpc_count integer;
  v_rpc_owner text;
  v_dashboard_owner text;
BEGIN
  IF to_regclass('public.users') IS NULL
     OR to_regclass('public.customers') IS NULL
     OR to_regclass('public.offers') IS NULL
     OR to_regclass('public.offer_items') IS NULL
     OR to_regclass('public.alerts') IS NULL
     OR to_regclass('public.notifications') IS NULL
     OR to_regclass('public.activities') IS NULL
     OR to_regclass('public.conversations') IS NULL THEN
    RAISE EXCEPTION 'Ofoq service-request security migration stopped: one or more required public tables are missing; inspect the target schema before applying';
  END IF;

  SELECT array_agg(required.column_name ORDER BY required.column_name)
    INTO v_missing
  FROM unnest(ARRAY[
    'users.id', 'users.email', 'users.name', 'users.role', 'users.status', 'users.created_at',
    'customers.id', 'customers.user_id', 'customers.email', 'customers.contact_name', 'customers.phone', 'customers.created_at', 'customers.updated_at',
    'offers.id', 'offers.code', 'offers.customer_id', 'offers.project_id', 'offers.status', 'offers.currency',
    'offers.subtotal_minor', 'offers.total_minor', 'offers.discount_minor', 'offers.internal_cost_minor', 'offers.margin_pct',
    'offers.valid_until', 'offers.pricing_reason', 'offers.pricing_breakdown', 'offers.client_note',
    'offers.internal_note', 'offers.created_by_agent', 'offers.created_by_user_id',
    'offers.approved_at', 'offers.rejected_at', 'offers.is_demo', 'offers.created_at', 'offers.updated_at',
    'offer_items.id', 'offer_items.offer_id', 'offer_items.description_ar',
    'alerts.id', 'alerts.severity', 'alerts.category', 'alerts.title_ar', 'alerts.title_en',
    'alerts.body_ar', 'alerts.body_en', 'alerts.entity_type', 'alerts.entity_id', 'alerts.customer_id',
    'alerts.target_role', 'alerts.status', 'alerts.dedupe_key', 'alerts.meta', 'alerts.is_demo', 'alerts.created_at', 'alerts.updated_at',
    'notifications.id', 'notifications.user_id', 'notifications.alert_id', 'notifications.channel',
    'notifications.subject', 'notifications.body', 'notifications.status', 'notifications.created_at',
    'activities.id', 'activities.actor_type', 'activities.actor_label', 'activities.action',
    'activities.entity_type', 'activities.entity_id', 'activities.customer_id', 'activities.summary',
    'activities.meta', 'activities.is_demo', 'activities.created_at',
    'conversations.id', 'conversations.customer_id'
  ]) AS required(column_name)
  WHERE NOT EXISTS (
    SELECT 1
    FROM information_schema.columns AS c
    WHERE c.table_schema = 'public'
      AND c.table_name = split_part(required.column_name, '.', 1)
      AND c.column_name = split_part(required.column_name, '.', 2)
  );

  IF coalesce(array_length(v_missing, 1), 0) > 0 THEN
    RAISE EXCEPTION 'Ofoq service-request security migration stopped: required columns are missing: %', array_to_string(v_missing, ', ');
  END IF;

  IF to_regprocedure('auth.uid()') IS NULL THEN
    RAISE EXCEPTION 'Ofoq service-request security migration stopped: auth.uid() is missing; verify the Supabase Auth schema before applying';
  END IF;

  IF to_regprocedure('public.ofoq_ensure_customer_profile()') IS NULL THEN
    RAISE EXCEPTION 'Ofoq service-request security migration stopped: public.ofoq_ensure_customer_profile() is missing; apply/verify the Auth portal migration first';
  END IF;

  IF to_regprocedure('public.ofoq_client_dashboard()') IS NULL THEN
    RAISE EXCEPTION 'Ofoq service-request security migration stopped: public.ofoq_client_dashboard() is missing; apply/verify 0001_auth_portal.sql before applying this migration';
  END IF;

  SELECT count(*) INTO v_rpc_count
  FROM pg_catalog.pg_proc AS p
  JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'ofoq_client_service_request';

  IF v_rpc_count = 0 THEN
    RAISE EXCEPTION 'Ofoq service-request security migration stopped: public.ofoq_client_service_request() from migration 0008 is missing; apply/verify it before applying this hardening migration';
  END IF;

  IF v_rpc_count > 1 THEN
    RAISE EXCEPTION 'Ofoq service-request security migration stopped: unexpected overloads of public.ofoq_client_service_request exist; inspect them before applying';
  END IF;

  IF v_rpc_count = 1
     AND to_regprocedure('public.ofoq_client_service_request(text, text, text, text, text, jsonb, jsonb, jsonb, text, text)') IS NULL THEN
    RAISE EXCEPTION 'Ofoq service-request security migration stopped: the installed RPC signature differs from the repository; inspect it rather than replacing an unknown function';
  END IF;

  SELECT r.rolname INTO v_rpc_owner
  FROM pg_catalog.pg_proc AS p
  JOIN pg_catalog.pg_roles AS r ON r.oid = p.proowner
  WHERE p.oid = to_regprocedure('public.ofoq_client_service_request(text, text, text, text, text, jsonb, jsonb, jsonb, text, text)');
  IF v_rpc_owner IS DISTINCT FROM current_user THEN
    RAISE EXCEPTION 'Ofoq service-request security migration stopped: run it as the existing RPC owner so the private price-verification table is owned by the SECURITY DEFINER role';
  END IF;

  SELECT r.rolname INTO v_dashboard_owner
  FROM pg_catalog.pg_proc AS p
  JOIN pg_catalog.pg_roles AS r ON r.oid = p.proowner
  WHERE p.oid = to_regprocedure('public.ofoq_client_dashboard()');
  IF v_dashboard_owner IS DISTINCT FROM current_user THEN
    RAISE EXCEPTION 'Ofoq service-request security migration stopped: run it as the owner of public.ofoq_client_dashboard() so the replacement keeps the same SECURITY DEFINER role';
  END IF;

  IF to_regclass('public.ofoq_service_request_price_verifications') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_class AS c
      WHERE c.oid = to_regclass('public.ofoq_service_request_price_verifications')
        AND c.relkind = 'r'
        AND pg_get_userbyid(c.relowner) = current_user
    ) THEN
      RAISE EXCEPTION 'Ofoq service-request security migration stopped: the existing price-verification object has an unexpected type or owner';
    END IF;

    SELECT array_agg(required.column_name ORDER BY required.column_name)
      INTO v_missing
    FROM unnest(ARRAY['offer_id', 'user_id', 'created_at']) AS required(column_name)
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns AS c
      WHERE c.table_schema = 'public'
        AND c.table_name = 'ofoq_service_request_price_verifications'
        AND c.column_name = required.column_name
    );
    IF coalesce(array_length(v_missing, 1), 0) > 0 THEN
      RAISE EXCEPTION 'Ofoq service-request security migration stopped: the existing price-verification table has unexpected columns';
    END IF;
  END IF;
END
$ofoq_service_request_security_preflight$;

-- `other` has no published price. These columns previously forced the request
-- path to persist 0, which could be mistaken for a real quote. DROP NOT NULL is
-- additive and does not alter any existing row.
ALTER TABLE public.offers ALTER COLUMN subtotal_minor DROP NOT NULL;
ALTER TABLE public.offers ALTER COLUMN total_minor DROP NOT NULL;

-- A private marker is needed because migration 0008 stored caller-controlled
-- pricing_breakdown JSON. Historical JSON (including a forged version string)
-- must never be enough to make an old quote trusted on an idempotent retry.
CREATE TABLE IF NOT EXISTS public.ofoq_service_request_price_verifications (
  offer_id   text PRIMARY KEY REFERENCES public.offers (id) ON DELETE CASCADE,
  user_id    text NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  created_at text NOT NULL
);
ALTER TABLE public.ofoq_service_request_price_verifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.ofoq_service_request_price_verifications FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.ofoq_client_service_request(
  p_request_id text,
  p_title_ar text,
  p_title_en text,
  p_body_ar text,
  p_body_en text,
  p_offer jsonb,
  p_contact jsonb,
  p_meta jsonb DEFAULT '{}'::jsonb,
  p_conversation_id text DEFAULT NULL,
  p_locale text DEFAULT 'ar'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_user_id text := (SELECT auth.uid())::text;
  v_role text;
  v_user_email text;
  v_customer_id text;
  v_customer_email text;
  v_customer_name text;
  v_customer_phone text;
  v_request_id text := nullif(trim(coalesce(p_request_id, '')), '');
  v_dedupe_key text;
  v_legacy_dedupe_key text;
  v_existing_alert_id text;
  v_existing_meta jsonb;
  v_existing_offer_id text;
  v_existing_order_code text;
  v_existing_offer_status text;
  v_existing_breakdown jsonb;
  v_existing_price jsonb;
  v_existing_price_verified boolean := false;
  v_year text := to_char(timezone('utc', now()), 'YYYY');
  v_sequence integer;
  v_code text;
  v_offer_id text := gen_random_uuid()::text;
  v_alert_id text := gen_random_uuid()::text;
  v_status text := 'DRAFT';
  v_pricing_input jsonb := p_offer -> 'pricing_breakdown';
  v_service_type text;
  v_size text;
  v_budget_band text;
  v_budget_source text;
  v_budget_amount_text text;
  v_budget_amount numeric;
  v_budget_range text;
  v_targeting text;
  v_range_amount numeric;
  v_range_band text;
  v_range_stated numeric;
  v_range_ceiling numeric;
  v_range_min numeric;
  v_range_max numeric;
  v_channel text := lower(coalesce(nullif(trim(p_contact ->> 'channel'), ''), 'website'));
  v_contact_value text := nullif(trim(coalesce(p_contact ->> 'value', '')), '');
  v_whatsapp_digits text;
  v_whatsapp_number text;
  v_whatsapp_link text;
  v_conversation_id text := NULL;
  v_entity_type text;
  v_entity_id text;
  v_locale text := CASE WHEN lower(trim(coalesce(p_locale, 'ar'))) = 'en' THEN 'en' ELSE 'ar' END;
  v_service_ar text;
  v_service_en text;
  v_size_ar text;
  v_size_en text;
  v_target_ar text;
  v_target_en text;
  v_budget_display_ar text;
  v_budget_display_en text;
  v_title_ar text;
  v_title_en text;
  v_body_ar text;
  v_body_en text;
  v_meta jsonb;
  v_staff_ids jsonb;
  v_base_min numeric;
  v_base_max numeric;
  v_size_multiplier numeric;
  v_platform_multiplier numeric;
  v_platforms text;
  v_min_price numeric;
  v_max_price numeric;
  v_mid_price numeric;
  v_total_minor bigint;
  v_expected_results jsonb;
  v_raw_impressions numeric;
  v_raw_visits numeric;
  v_raw_leads numeric;
  v_reach_factor numeric;
  v_cpm_factor numeric;
  v_estimated_ad_days integer;
  v_price jsonb;
  v_pricing_breakdown jsonb;
  v_now text := to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  -- The legacy argument names remain for rolling deployment compatibility.
  -- p_offer.pricing_breakdown is untrusted request input; all money, labels,
  -- messages and metadata below are derived here. p_offer totals, p_meta,
  -- p_title_* and p_body_* are intentionally ignored.
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required or account inactive' USING ERRCODE = '28000';
  END IF;

  SELECT u.role, lower(u.email)
    INTO v_role, v_user_email
  FROM public.users AS u
  WHERE u.id = v_user_id AND u.status = 'ACTIVE';

  IF v_role IS NULL THEN
    RAISE EXCEPTION 'Authentication required or account inactive' USING ERRCODE = '28000';
  END IF;

  IF v_request_id IS NULL OR v_request_id !~ '^[A-Za-z0-9_-]{8,80}$' THEN
    RAISE EXCEPTION 'A valid request id is required' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_offer) IS DISTINCT FROM 'object'
     OR jsonb_typeof(v_pricing_input) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Validated service-request pricing inputs are required' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_contact) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Contact details are required' USING ERRCODE = '22023';
  END IF;
  IF v_channel NOT IN ('whatsapp', 'email', 'website') THEN
    RAISE EXCEPTION 'Unknown contact channel' USING ERRCODE = '22023';
  END IF;

  v_service_type := lower(trim(coalesce(v_pricing_input ->> 'serviceType', '')));
  IF v_service_type = 'social_media' THEN
    v_service_type := 'social';
  END IF;
  IF v_service_type NOT IN ('design', 'ads', 'social', 'content', 'seo', 'other') THEN
    RAISE EXCEPTION 'Unknown service type' USING ERRCODE = '22023';
  END IF;

  v_size := lower(trim(coalesce(v_pricing_input ->> 'size', '')));
  IF v_size NOT IN ('small', 'medium', 'large') THEN
    RAISE EXCEPTION 'Unknown service size' USING ERRCODE = '22023';
  END IF;

  v_budget_band := lower(trim(coalesce(v_pricing_input ->> 'budgetBand', '')));
  IF v_budget_band NOT IN ('under_200', '200_500', '500_1500', 'over_1500') THEN
    RAISE EXCEPTION 'Unknown budget band' USING ERRCODE = '22023';
  END IF;

  v_targeting := lower(trim(coalesce(v_pricing_input ->> 'targeting', '')));
  IF v_targeting NOT IN ('iraq_all', 'baghdad', 'basra', 'three_cities', 'gulf', 'arabic_global') THEN
    RAISE EXCEPTION 'Unknown targeting area' USING ERRCODE = '22023';
  END IF;

  v_budget_source := CASE WHEN v_pricing_input ->> 'budgetSource' = 'typed' THEN 'typed' ELSE 'option' END;
  IF v_budget_source = 'typed' THEN
    v_budget_amount_text := nullif(trim(v_pricing_input ->> 'budgetAmount'), '');
    IF v_budget_amount_text IS NULL OR v_budget_amount_text !~ '^[0-9]{1,7}$' THEN
      RAISE EXCEPTION 'A typed budget must be a positive whole-dollar amount' USING ERRCODE = '22023';
    END IF;
    v_budget_amount := v_budget_amount_text::numeric;
    v_budget_range := nullif(trim(v_pricing_input ->> 'budgetRange'), '');
    IF v_budget_range IS NULL OR v_budget_range !~ '^([0-9]{1,7}(-[0-9]{1,7})?|[<>][0-9]{1,7})$' THEN
      RAISE EXCEPTION 'A typed budget range is invalid' USING ERRCODE = '22023';
    END IF;

    -- Match the canonical values produced by budget-parser.ts: a closed range
    -- plans on its upper end, an open floor on its midpoint to the band ceiling,
    -- an open ceiling on its ceiling, and a single value on itself.
    IF left(v_budget_range, 1) = '>' THEN
      v_range_stated := substring(v_budget_range FROM 2)::numeric;
      v_range_ceiling := CASE
        WHEN v_range_stated + 1 <= 200 THEN 200
        WHEN v_range_stated + 1 <= 500 THEN 500
        WHEN v_range_stated + 1 <= 1500 THEN 1500
        ELSE 3000
      END;
      v_range_amount := round((v_range_stated + v_range_ceiling) / 2);
    ELSIF left(v_budget_range, 1) = '<' THEN
      v_range_stated := substring(v_budget_range FROM 2)::numeric;
      v_range_ceiling := CASE
        WHEN v_range_stated <= 200 THEN 200
        WHEN v_range_stated <= 500 THEN 500
        WHEN v_range_stated <= 1500 THEN 1500
        ELSE 3000
      END;
      v_range_amount := least(v_range_stated, v_range_ceiling);
    ELSIF position('-' IN v_budget_range) > 0 THEN
      v_range_min := split_part(v_budget_range, '-', 1)::numeric;
      v_range_max := split_part(v_budget_range, '-', 2)::numeric;
      IF v_range_min > v_range_max THEN
        RAISE EXCEPTION 'Typed budget range must be in ascending order' USING ERRCODE = '22023';
      END IF;
      v_range_amount := v_range_max;
    ELSE
      v_range_amount := v_budget_range::numeric;
    END IF;

    v_range_band := CASE
      WHEN v_range_amount <= 200 THEN 'under_200'
      WHEN v_range_amount <= 500 THEN '200_500'
      WHEN v_range_amount <= 1500 THEN '500_1500'
      ELSE 'over_1500'
    END;
    IF v_range_amount <> v_budget_amount OR v_range_band <> v_budget_band THEN
      RAISE EXCEPTION 'Typed budget details do not match the selected band' USING ERRCODE = '22023';
    END IF;
  ELSE
    -- A button-selected band always uses its existing published planning value.
    -- Ignore any caller-supplied amount in this case.
    v_budget_amount := CASE v_budget_band
      WHEN 'under_200' THEN 200
      WHEN '200_500' THEN 500
      WHEN '500_1500' THEN 1500
      ELSE 3000
    END;
    v_budget_range := CASE v_budget_band
      WHEN 'under_200' THEN '<200'
      WHEN '200_500' THEN '200-500'
      WHEN '500_1500' THEN '500-1500'
      ELSE '>1500'
    END;
  END IF;

  IF v_budget_amount <= 0 OR v_budget_amount > 1000000 THEN
    RAISE EXCEPTION 'Budget amount is outside the supported range' USING ERRCODE = '22023';
  END IF;
  IF (v_budget_band = 'under_200' AND v_budget_amount > 200)
     OR (v_budget_band = '200_500' AND (v_budget_amount <= 200 OR v_budget_amount > 500))
     OR (v_budget_band = '500_1500' AND (v_budget_amount <= 500 OR v_budget_amount > 1500))
     OR (v_budget_band = 'over_1500' AND v_budget_amount <= 1500) THEN
    RAISE EXCEPTION 'Budget amount does not match its selected band' USING ERRCODE = '22023';
  END IF;

  -- The quote catalog and multipliers are kept identical to pricing-agent.ts.
  CASE v_service_type
    WHEN 'design' THEN v_base_min := 500; v_base_max := 1200;
    WHEN 'ads' THEN v_base_min := 300; v_base_max := 1500;
    WHEN 'social' THEN v_base_min := 300; v_base_max := 800;
    WHEN 'content' THEN v_base_min := 250; v_base_max := 600;
    WHEN 'seo' THEN v_base_min := 400; v_base_max := 1000;
    ELSE v_base_min := NULL; v_base_max := NULL;
  END CASE;
  v_size_multiplier := CASE v_size WHEN 'small' THEN 0.8 WHEN 'large' THEN 1.5 ELSE 1.0 END;
  v_platforms := CASE WHEN v_budget_amount <= 200 THEN 'single' ELSE 'multiple' END;
  v_platform_multiplier := CASE WHEN v_platforms = 'single' THEN 1.0 ELSE 1.3 END;

  IF v_base_min IS NULL THEN
    v_min_price := NULL;
    v_max_price := NULL;
    v_mid_price := NULL;
    v_total_minor := NULL;
  ELSE
    v_min_price := round(v_base_min * v_size_multiplier * v_platform_multiplier);
    v_max_price := round(v_base_max * v_size_multiplier * v_platform_multiplier);
    v_mid_price := round((v_min_price + v_max_price) / 2);
    v_total_minor := round(v_mid_price * 100)::bigint;
  END IF;

  v_price := jsonb_build_object(
    'min', v_min_price,
    'max', v_max_price,
    'mid', v_mid_price,
    'currency', 'USD'
  );

  -- The published ad-result formulas and rounding steps mirror pricing-agent.ts.
  v_expected_results := NULL;
  v_estimated_ad_days := NULL;
  IF v_service_type = 'ads' THEN
    CASE v_targeting
      WHEN 'iraq_all' THEN v_reach_factor := 1.0; v_cpm_factor := 1.0;
      WHEN 'baghdad' THEN v_reach_factor := 0.35; v_cpm_factor := 1.2;
      WHEN 'basra' THEN v_reach_factor := 0.12; v_cpm_factor := 0.9;
      WHEN 'three_cities' THEN v_reach_factor := 0.55; v_cpm_factor := 1.05;
      WHEN 'gulf' THEN v_reach_factor := 0.8; v_cpm_factor := 4.0;
      ELSE v_reach_factor := 1.5; v_cpm_factor := 2.0;
    END CASE;
    v_raw_impressions := ((v_budget_amount * 0.8) / (3 * v_cpm_factor)) * 1000 * v_reach_factor * 0.995;
    v_raw_visits := v_raw_impressions * 0.01;
    v_raw_leads := v_raw_visits * 0.025;
    v_expected_results := jsonb_build_object(
      'impressions', jsonb_build_array(
        greatest(0, floor(v_raw_impressions * 0.7 / 1000) * 1000),
        greatest(0, round(v_raw_impressions * 1.3 / 1000) * 1000)
      ),
      'visits', jsonb_build_array(
        greatest(0, floor(v_raw_visits * 0.7 / 10) * 10),
        greatest(0, round(v_raw_visits * 1.3 / 10) * 10)
      ),
      'leads', jsonb_build_array(
        greatest(0, floor(v_raw_leads * 0.7)),
        greatest(0, round(v_raw_leads * 1.3))
      )
    );
    v_estimated_ad_days := greatest(1, least(30, floor(v_budget_amount * 0.8 / 10)::integer));
  END IF;

  v_budget_display_ar := CASE
    WHEN v_budget_source = 'typed' AND left(v_budget_range, 1) = '>' THEN 'أكثر من ' || substring(v_budget_range FROM 2) || '$'
    WHEN v_budget_source = 'typed' AND left(v_budget_range, 1) = '<' THEN 'أقل من ' || substring(v_budget_range FROM 2) || '$'
    WHEN v_budget_source = 'typed' THEN v_budget_range || '$'
    WHEN v_budget_band = 'under_200' THEN 'أقل من 200$'
    WHEN v_budget_band = '200_500' THEN '200-500$'
    WHEN v_budget_band = '500_1500' THEN '500-1500$'
    ELSE 'أكثر من 1500$'
  END;
  v_budget_display_en := CASE
    WHEN v_budget_source = 'typed' AND left(v_budget_range, 1) = '>' THEN 'over $' || substring(v_budget_range FROM 2)
    WHEN v_budget_source = 'typed' AND left(v_budget_range, 1) = '<' THEN 'under $' || substring(v_budget_range FROM 2)
    WHEN v_budget_source = 'typed' AND position('-' IN v_budget_range) > 0 THEN '$' || v_budget_range
    WHEN v_budget_source = 'typed' THEN '$' || v_budget_range
    WHEN v_budget_band = 'under_200' THEN 'Under $200'
    WHEN v_budget_band = '200_500' THEN '$200-500'
    WHEN v_budget_band = '500_1500' THEN '$500-1500'
    ELSE 'Over $1500'
  END;

  v_service_ar := CASE v_service_type
    WHEN 'design' THEN 'تصميم' WHEN 'ads' THEN 'إعلانات' WHEN 'social' THEN 'سوشيال ميديا'
    WHEN 'content' THEN 'محتوى' WHEN 'seo' THEN 'SEO' ELSE 'غير ذلك'
  END;
  v_service_en := CASE v_service_type
    WHEN 'design' THEN 'Design' WHEN 'ads' THEN 'Ads' WHEN 'social' THEN 'Social media'
    WHEN 'content' THEN 'Content' WHEN 'seo' THEN 'SEO' ELSE 'Other'
  END;
  v_size_ar := CASE v_size WHEN 'small' THEN 'صغير' WHEN 'large' THEN 'كبير' ELSE 'متوسط' END;
  v_size_en := CASE v_size WHEN 'small' THEN 'Small' WHEN 'large' THEN 'Large' ELSE 'Medium' END;
  v_target_ar := CASE v_targeting
    WHEN 'iraq_all' THEN 'العراق كله' WHEN 'baghdad' THEN 'بغداد فقط' WHEN 'basra' THEN 'البصرة فقط'
    WHEN 'three_cities' THEN 'بغداد + البصرة + أربيل' WHEN 'gulf' THEN 'الخليج'
    ELSE 'جمهور عربي عام'
  END;
  v_target_en := CASE v_targeting
    WHEN 'iraq_all' THEN 'All Iraq' WHEN 'baghdad' THEN 'Baghdad only' WHEN 'basra' THEN 'Basra only'
    WHEN 'three_cities' THEN 'Baghdad + Basra + Erbil' WHEN 'gulf' THEN 'Gulf'
    ELSE 'General Arabic-speaking audience'
  END;

  -- Resolve/create only the caller's own customer row, then scope idempotency
  -- to that identity. The legacy unscoped key is read only with an ownership
  -- predicate so existing same-client retries remain idempotent.
  v_customer_id := public.ofoq_ensure_customer_profile();
  SELECT c.email, c.contact_name, c.phone
    INTO v_customer_email, v_customer_name, v_customer_phone
  FROM public.customers AS c
  WHERE c.id = v_customer_id AND c.user_id = v_user_id;
  IF v_customer_id IS NULL OR v_customer_email IS NULL AND v_user_email IS NULL THEN
    RAISE EXCEPTION 'The active account has no customer profile' USING ERRCODE = '28000';
  END IF;

  IF v_channel = 'email' THEN
    v_contact_value := coalesce(nullif(trim(v_customer_email), ''), nullif(trim(v_user_email), ''));
  ELSIF v_channel = 'website' THEN
    v_contact_value := NULL;
  ELSE
    IF v_contact_value IS NULL THEN
      RAISE EXCEPTION 'A WhatsApp number is required' USING ERRCODE = '22023';
    END IF;
    v_whatsapp_digits := translate(
      regexp_replace(v_contact_value, '[^0-9٠-٩]', '', 'g'),
      '٠١٢٣٤٥٦٧٨٩', '0123456789'
    );
    IF length(v_whatsapp_digits) < 10 OR length(v_whatsapp_digits) > 15
       OR NOT (left(v_whatsapp_digits, 2) = '07' OR left(v_whatsapp_digits, 3) = '964'
               OR left(trim(v_contact_value), 4) = '+964') THEN
      RAISE EXCEPTION 'A valid WhatsApp number is required' USING ERRCODE = '22023';
    END IF;
    v_whatsapp_number := CASE
      WHEN left(v_whatsapp_digits, 1) = '0' THEN '964' || substring(v_whatsapp_digits FROM 2)
      ELSE v_whatsapp_digits
    END;
    v_whatsapp_link := 'https://wa.me/' || v_whatsapp_number;
  END IF;

  v_dedupe_key := 'service-request:' || v_user_id || ':' || v_request_id;
  v_legacy_dedupe_key := 'service-request:' || v_request_id;
  PERFORM pg_advisory_xact_lock(hashtext(v_dedupe_key));

  SELECT a.id, coalesce(a.meta, '{}')::jsonb
    INTO v_existing_alert_id, v_existing_meta
  FROM public.alerts AS a
  WHERE a.customer_id = v_customer_id
    AND a.dedupe_key IN (v_dedupe_key, v_legacy_dedupe_key)
  ORDER BY CASE WHEN a.dedupe_key = v_dedupe_key THEN 0 ELSE 1 END
  LIMIT 1;

  IF v_existing_alert_id IS NOT NULL THEN
    SELECT o.id, o.code, o.status, o.pricing_breakdown::jsonb
      INTO v_existing_offer_id, v_existing_order_code, v_existing_offer_status, v_existing_breakdown
    FROM public.offers AS o
    WHERE o.id = v_existing_meta ->> 'offerId'
      AND o.customer_id = v_customer_id;

    IF v_existing_offer_id IS NULL THEN
      RAISE EXCEPTION 'The existing request reference is inconsistent; contact the agency' USING ERRCODE = '23503';
    END IF;

    -- Migration 0008 let the caller supply pricing_breakdown, so the version
    -- string alone is not trustworthy on a historical row. Require the private
    -- DB-owned marker written atomically with this offer by migration 0010.
    v_existing_price_verified := coalesce(
      EXISTS (
        SELECT 1 FROM public.ofoq_service_request_price_verifications AS trusted
        WHERE trusted.offer_id = v_existing_offer_id AND trusted.user_id = v_user_id
      )
      AND v_existing_breakdown ->> 'calculationVersion' = 'service-request-db-v1',
      false
    );
    IF v_existing_price_verified THEN
      v_existing_price := v_existing_breakdown -> 'price';
    ELSE
      -- Never treat a pre-migration caller-supplied total as a trusted estimate.
      v_existing_price := jsonb_build_object('min', NULL, 'max', NULL, 'mid', NULL, 'currency', 'USD');
    END IF;

    RETURN jsonb_build_object(
      'requestId', v_request_id,
      'orderCode', v_existing_order_code,
      'offerId', v_existing_offer_id,
      'offerStatus', v_existing_offer_status,
      'alertId', v_existing_alert_id,
      'created', false,
      'category', 'NEW_REQUEST',
      'severity', 'IMPORTANT',
      'price', v_existing_price,
      'priceVerified', v_existing_price_verified
    );
  END IF;

  -- Order reference: OFOQ-<year>-<sequence>, serialized inside this transaction.
  PERFORM pg_advisory_xact_lock(hashtext('ofoq_service_request_code'));
  SELECT coalesce(max(nullif(regexp_replace(o.code, '^OFOQ-' || v_year || '-', ''), '')::integer), 0) + 1
    INTO v_sequence
  FROM public.offers AS o
  WHERE o.code ~ ('^OFOQ-' || v_year || '-[0-9]+$');
  v_code := 'OFOQ-' || v_year || '-' || lpad(v_sequence::text, 3, '0');

  -- Link a conversation only when it belongs to this authenticated customer.
  IF p_conversation_id IS NOT NULL AND length(trim(p_conversation_id)) > 0 THEN
    SELECT c.id INTO v_conversation_id
    FROM public.conversations AS c
    WHERE c.id = p_conversation_id AND c.customer_id = v_customer_id;
  END IF;

  v_pricing_breakdown := jsonb_build_object(
    'requestId', v_request_id,
    'orderCode', v_code,
    'serviceType', v_service_type,
    'size', v_size,
    'budgetBand', v_budget_band,
    'budgetAmount', v_budget_amount,
    'budgetRange', v_budget_range,
    'budgetSource', v_budget_source,
    'targeting', v_targeting,
    'platforms', v_platforms,
    'price', v_price,
    'expectedResults', v_expected_results,
    'estimatedAdDays', v_estimated_ad_days,
    'contact', jsonb_build_object(
      'channel', v_channel,
      'value', v_contact_value,
      'whatsappNumber', v_whatsapp_number,
      'whatsappLink', v_whatsapp_link
    ),
    'conversationId', v_conversation_id,
    'customerId', v_customer_id,
    'status', v_status,
    'source', 'guided_service_request',
    'calculationVersion', 'service-request-db-v1'
  );

  v_title_ar := 'طلب خدمة جديد #' || v_code;
  v_title_en := 'New service request #' || v_code;
  v_body_ar := 'رقم الطلب: ' || v_code
    || E'\nالعميل: ' || coalesce(v_customer_name, '')
    || E'\nالخدمة: ' || v_service_ar
    || E'\nالحجم: ' || v_size_ar
    || E'\nالميزانية: ' || v_budget_display_ar
    || E'\nالمنطقة المستهدفة: ' || v_target_ar
    || E'\n' || CASE
      WHEN v_min_price IS NULL THEN 'السعر التقديري: يحتاج مراجعة؛ لا يوجد سعر محدد لهذا النوع.'
      ELSE 'نطاق السعر التقديري: $' || v_min_price::text || ' - $' || v_max_price::text
    END
    || CASE WHEN v_service_type = 'ads' THEN
      E'\nالظهور المتوقع: ' || to_char((v_expected_results -> 'impressions' ->> 0)::numeric, 'FM999,999,999,999')
        || ' - ' || to_char((v_expected_results -> 'impressions' ->> 1)::numeric, 'FM999,999,999,999')
        || E'\nالزيارات المتوقعة: ' || to_char((v_expected_results -> 'visits' ->> 0)::numeric, 'FM999,999,999,999')
        || ' - ' || to_char((v_expected_results -> 'visits' ->> 1)::numeric, 'FM999,999,999,999')
        || E'\nالمهتمون المتوقعون: ' || to_char((v_expected_results -> 'leads' ->> 0)::numeric, 'FM999,999,999,999')
        || ' - ' || to_char((v_expected_results -> 'leads' ->> 1)::numeric, 'FM999,999,999,999')
        || E'\nمدة الإعلان التقديرية: ' || v_estimated_ad_days::text || ' يوم'
      ELSE '' END
    || E'\n' || CASE v_channel
      WHEN 'whatsapp' THEN 'قناة التواصل: واتساب' || E'\nرقم العميل: ' || v_contact_value
        || E'\nرابط واتساب: ' || v_whatsapp_link
      WHEN 'email' THEN 'قناة التواصل: البريد الإلكتروني — ' || coalesce(v_contact_value, '')
      ELSE 'قناة التواصل: إشعار في الموقع'
    END;
  v_body_en := 'Order reference: ' || v_code
    || E'\nClient: ' || coalesce(v_customer_name, '')
    || E'\nService: ' || v_service_en
    || E'\nSize: ' || v_size_en
    || E'\nBudget: ' || v_budget_display_en
    || E'\nTarget area: ' || v_target_en
    || E'\n' || CASE
      WHEN v_min_price IS NULL THEN 'Estimated price: needs review; no price is defined for this service.'
      ELSE 'Estimated price range: $' || v_min_price::text || ' - $' || v_max_price::text
    END
    || CASE WHEN v_service_type = 'ads' THEN
      E'\nExpected impressions: ' || to_char((v_expected_results -> 'impressions' ->> 0)::numeric, 'FM999,999,999,999')
        || ' - ' || to_char((v_expected_results -> 'impressions' ->> 1)::numeric, 'FM999,999,999,999')
        || E'\nExpected visits: ' || to_char((v_expected_results -> 'visits' ->> 0)::numeric, 'FM999,999,999,999')
        || ' - ' || to_char((v_expected_results -> 'visits' ->> 1)::numeric, 'FM999,999,999,999')
        || E'\nExpected leads: ' || to_char((v_expected_results -> 'leads' ->> 0)::numeric, 'FM999,999,999,999')
        || ' - ' || to_char((v_expected_results -> 'leads' ->> 1)::numeric, 'FM999,999,999,999')
        || E'\nEstimated ad days: ' || v_estimated_ad_days::text
      ELSE '' END
    || E'\n' || CASE v_channel
      WHEN 'whatsapp' THEN 'Contact channel: WhatsApp' || E'\nClient number: ' || v_contact_value
        || E'\nWhatsApp link: ' || v_whatsapp_link
      WHEN 'email' THEN 'Contact channel: email — ' || coalesce(v_contact_value, '')
      ELSE 'Contact channel: in-app notification'
    END;

  IF v_conversation_id IS NOT NULL THEN
    v_entity_type := 'conversation';
    v_entity_id := v_conversation_id;
  ELSE
    v_entity_type := 'service_request';
    v_entity_id := v_offer_id;
  END IF;

  v_meta := jsonb_build_object(
    'source', 'guided_service_request',
    'requestId', v_request_id,
    'orderCode', v_code,
    'offerId', v_offer_id,
    'offerStatus', v_status,
    'conversationId', v_conversation_id,
    'customerId', v_customer_id,
    'contact', jsonb_build_object(
      'channel', v_channel,
      'value', v_contact_value,
      'whatsappNumber', v_whatsapp_number,
      'whatsappLink', v_whatsapp_link
    ),
    'whatsapp', CASE WHEN v_channel = 'whatsapp' THEN jsonb_build_object(
      'channel', 'واتساب',
      'number', v_contact_value,
      'international', v_whatsapp_number,
      'link', v_whatsapp_link
    ) ELSE NULL END,
    'budget', jsonb_build_object(
      'band', v_budget_band,
      'range', v_budget_range,
      'amount', v_budget_amount,
      'source', v_budget_source,
      'display', v_budget_display_ar
    ),
    'price', v_price,
    'expectedResults', v_expected_results,
    'estimatedAdDays', v_estimated_ad_days,
    'clientEmail', coalesce(v_customer_email, v_user_email),
    'raisedByRole', v_role,
    'raisedByUserId', v_user_id,
    'locale', v_locale
  );

  INSERT INTO public.offers
    (id, code, customer_id, project_id, status, currency,
     subtotal_minor, discount_minor, total_minor, internal_cost_minor, margin_pct,
     valid_until, pricing_reason, pricing_breakdown, client_note, internal_note,
     created_by_agent, created_by_user_id, approved_at, rejected_at, is_demo,
     created_at, updated_at)
  VALUES
    (v_offer_id, v_code, v_customer_id, NULL, v_status, 'USD',
     v_total_minor, 0, v_total_minor, 0, NULL,
     NULL,
     'service_request:' || v_service_type || ':' || v_budget_band || ':' || v_targeting,
     v_pricing_breakdown::text,
     CASE WHEN v_locale = 'ar'
       THEN 'طلب خدمة ' || v_service_ar || ' من المساعد الموجّه'
       ELSE v_service_en || ' service request from the guided assistant'
     END,
     CASE v_channel
       WHEN 'whatsapp' THEN 'قناة التواصل: واتساب — ' || v_contact_value
       WHEN 'email' THEN 'قناة التواصل: البريد الإلكتروني — ' || coalesce(v_contact_value, '')
       ELSE 'قناة التواصل: إشعار في الموقع'
     END,
     'pricing-agent', NULL, NULL, NULL, 0,
     v_now, v_now);

  INSERT INTO public.ofoq_service_request_price_verifications (offer_id, user_id, created_at)
  VALUES (v_offer_id, v_user_id, v_now);

  INSERT INTO public.alerts
    (id, severity, category, title_ar, title_en, body_ar, body_en,
     entity_type, entity_id, customer_id, target_role, status,
     dedupe_key, meta, is_demo, created_at, updated_at)
  VALUES
    (v_alert_id, 'IMPORTANT', 'NEW_REQUEST', v_title_ar, v_title_en, v_body_ar, v_body_en,
     v_entity_type, v_entity_id, v_customer_id, 'ANY_STAFF', 'NEW',
     v_dedupe_key, v_meta::text, 0, v_now, v_now);

  IF v_channel = 'whatsapp' AND (v_customer_phone IS NULL OR length(trim(v_customer_phone)) = 0) THEN
    UPDATE public.customers
    SET phone = v_contact_value, updated_at = v_now
    WHERE id = v_customer_id AND user_id = v_user_id AND (phone IS NULL OR phone = '');
  END IF;

  -- Keep internal notifications unchanged without exposing the recipient list
  -- in the RPC result. Email-to-owner remains sent by the application service.
  SELECT coalesce(jsonb_agg(u.id ORDER BY u.created_at), '[]'::jsonb)
    INTO v_staff_ids
  FROM public.users AS u
  WHERE u.role IN ('OWNER', 'PARTNER') AND u.status = 'ACTIVE';

  INSERT INTO public.notifications (id, user_id, alert_id, channel, subject, body, status, created_at)
  SELECT gen_random_uuid()::text, staff.user_id, v_alert_id, 'IN_APP', v_title_ar, v_body_ar, 'SENT', v_now
  FROM jsonb_array_elements_text(v_staff_ids) AS staff(user_id);

  INSERT INTO public.notifications (id, user_id, alert_id, channel, subject, body, status, created_at)
  SELECT gen_random_uuid()::text, staff.user_id, v_alert_id, 'EMAIL', v_title_ar, v_body_ar, 'QUEUED', v_now
  FROM jsonb_array_elements_text(v_staff_ids) AS staff(user_id);

  INSERT INTO public.activities
    (id, actor_type, actor_label, action, entity_type, entity_id, customer_id,
     summary, meta, is_demo, created_at)
  VALUES
    (gen_random_uuid()::text, 'AGENT', 'pricing-agent', 'service_request.submitted',
     'service_request', v_offer_id, v_customer_id,
     v_title_ar,
     jsonb_build_object(
       'requestId', v_request_id,
       'orderCode', v_code,
       'offerId', v_offer_id,
       'offerStatus', v_status,
       'alertId', v_alert_id,
       'category', 'NEW_REQUEST',
       'severity', 'IMPORTANT',
       'contact', jsonb_build_object('channel', v_channel, 'value', v_contact_value, 'whatsappLink', v_whatsapp_link),
       'conversationId', v_conversation_id,
       'raisedByRole', v_role,
       'price', v_price
     )::text,
     0, v_now);

  RETURN jsonb_build_object(
    'requestId', v_request_id,
    'orderCode', v_code,
    'offerId', v_offer_id,
    'offerStatus', v_status,
    'alertId', v_alert_id,
    'created', true,
    'category', 'NEW_REQUEST',
    'severity', 'IMPORTANT',
    'price', v_price,
    'priceVerified', true
  );
END;
$function$;

-- Replace the client dashboard RPC so the offer section uses a positive
-- allowlist instead of exposing every status except CANCELLED/EXPIRED. The
-- function is SECURITY DEFINER because direct SELECT on offers is revoked; the
-- customer ownership predicate and every other dashboard section stay exactly
-- as shipped in 0001_auth_portal.sql. The replace keeps the installed owner
-- (checked in the preflight) and its ACL, which is re-asserted below.
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
      -- Positive allowlist of published offer states. DRAFT is internal
      -- (including guided service requests awaiting staff review), and
      -- EXPIRED/CANCELLED were already hidden by the original dashboard.
      AND o.status IN ('SENT', 'APPROVED', 'REJECTED')
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

-- Direct table SELECT previously granted by docs/setup/rls-policies.sql could
-- expose internal offer columns. Read offers only through the allowlisted,
-- ownership-checked client/admin SECURITY DEFINER RPCs.
REVOKE ALL PRIVILEGES ON TABLE public.offers, public.offer_items FROM PUBLIC, anon, authenticated;

-- Also clear any legacy column-level grants. A table-level REVOKE alone does
-- not reliably remove separately granted SELECT(column) privileges.
DO $revoke_offer_column_privileges$
DECLARE
  v_table text;
  v_columns text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['offers', 'offer_items'] LOOP
    SELECT string_agg(quote_ident(c.column_name), ', ' ORDER BY c.ordinal_position)
      INTO v_columns
    FROM information_schema.columns AS c
    WHERE c.table_schema = 'public' AND c.table_name = v_table;

    IF v_columns IS NOT NULL THEN
      EXECUTE 'REVOKE ALL PRIVILEGES (' || v_columns || ') ON TABLE public.'
        || quote_ident(v_table) || ' FROM PUBLIC, anon, authenticated';
    END IF;
  END LOOP;
END
$revoke_offer_column_privileges$;

REVOKE ALL ON FUNCTION public.ofoq_client_service_request(text, text, text, text, text, jsonb, jsonb, jsonb, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ofoq_client_service_request(text, text, text, text, text, jsonb, jsonb, jsonb, text, text) TO authenticated;

-- The dashboard stays callable only by signed-in users. Re-assert the ACL
-- explicitly because the replacement function is the only offer read path.
REVOKE ALL ON FUNCTION public.ofoq_client_dashboard() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ofoq_client_dashboard() TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- Supabase Auth, portal RPCs, RLS/column privileges and platform logs.
-- Source: db/migrations/supabase/0011_project_plans.sql.
-- =============================================================================
-- Ofoq — project plans for the client portal (وكيل إدارة المشاريع).
-- -----------------------------------------------------------------------------
-- This is a NEW migration. It is NOT applied by this pull request: run it
-- manually in the Supabase SQL Editor (as the owner of the RPCs, normally
-- `postgres`) after the core schema and 0010_harden_service_requests_and_offer_access.sql.
--
-- What it adds:
--   * RLS + privilege hardening for public.project_plans: no direct client
--     read, the plan is only served through the ownership-checked RPCs below.
--   * ofoq_client_dashboard() is replaced so every project also carries the
--     APPROVED plan (its phases and the client-visible tasks of each phase).
--     Internal tasks, internal notes and unapproved plans are never returned.
--   * ofoq_client_project_detail(p_project_id) — the client-safe view of one
--     project: status, progress, client-visible tasks and the approved plan.
--
-- The preflight fails closed when the required tables/columns/functions are
-- missing, so a partial deployment is stopped instead of half-applied.
-- =============================================================================

BEGIN;

-- ── Bootstrap (idempotent) ───────────────────────────────────────────────────
-- The plan table and the two task columns are created here so this migration
-- can be applied to a portal that only carries the core schema. The shape is
-- the one generated from db/migrations/sqlite/0004_project_plans.sql.
CREATE TABLE IF NOT EXISTS public.project_plans (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES public.projects (id) ON DELETE CASCADE,
  version             BIGINT NOT NULL DEFAULT 1,
  status              TEXT NOT NULL CHECK (status IN ('DRAFT', 'AWAITING_APPROVAL', 'APPROVED', 'SUPERSEDED')),
  locale              TEXT NOT NULL DEFAULT 'ar',
  summary             TEXT,
  phases              TEXT NOT NULL DEFAULT '[]',
  start_date          TEXT,
  due_date            TEXT,
  created_by_user_id  TEXT REFERENCES public.users (id) ON DELETE SET NULL,
  created_by_agent    TEXT,
  approved_by_user_id TEXT REFERENCES public.users (id) ON DELETE SET NULL,
  approved_at         TEXT,
  review_note         TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_project_plans_project_version
  ON public.project_plans (project_id, version);

CREATE INDEX IF NOT EXISTS idx_project_plans_project
  ON public.project_plans (project_id, status);

ALTER TABLE public.project_tasks ADD COLUMN IF NOT EXISTS internal_note TEXT;

ALTER TABLE public.project_tasks ADD COLUMN IF NOT EXISTS phase_key TEXT;

CREATE INDEX IF NOT EXISTS idx_project_tasks_phase
  ON public.project_tasks (project_id, phase_key);

DO $ofoq_project_plan_preflight$
DECLARE
  v_missing text[];
  v_dashboard_owner text;
BEGIN
  IF to_regclass('public.users') IS NULL
     OR to_regclass('public.customers') IS NULL
     OR to_regclass('public.projects') IS NULL
     OR to_regclass('public.project_tasks') IS NULL
     OR to_regclass('public.project_plans') IS NULL THEN
    RAISE EXCEPTION 'Ofoq project-plan migration stopped: one or more required public tables are missing; apply the core schema first (the plan table itself is created by this migration)';
  END IF;

  SELECT array_agg(required.column_name ORDER BY required.column_name)
    INTO v_missing
  FROM unnest(ARRAY[
    'users.id', 'users.status',
    'customers.id', 'customers.user_id',
    'projects.id', 'projects.customer_id', 'projects.status', 'projects.progress',
    'project_tasks.id', 'project_tasks.project_id', 'project_tasks.visibility', 'project_tasks.phase_key',
    'project_plans.id', 'project_plans.project_id', 'project_plans.version', 'project_plans.status',
    'project_plans.phases', 'project_plans.approved_at', 'project_plans.summary'
  ]) AS required(column_name)
  WHERE NOT EXISTS (
    SELECT 1
    FROM information_schema.columns AS c
    WHERE c.table_schema = 'public'
      AND c.table_name = split_part(required.column_name, '.', 1)
      AND c.column_name = split_part(required.column_name, '.', 2)
  );

  IF coalesce(array_length(v_missing, 1), 0) > 0 THEN
    RAISE EXCEPTION 'Ofoq project-plan migration stopped: required columns are missing: %', array_to_string(v_missing, ', ');
  END IF;

  IF to_regprocedure('auth.uid()') IS NULL THEN
    RAISE EXCEPTION 'Ofoq project-plan migration stopped: auth.uid() is missing; verify the Supabase Auth schema before applying';
  END IF;

  IF to_regprocedure('public.ofoq_client_dashboard()') IS NULL THEN
    RAISE EXCEPTION 'Ofoq project-plan migration stopped: public.ofoq_client_dashboard() is missing; apply/verify 0001_auth_portal.sql first';
  END IF;

  SELECT r.rolname INTO v_dashboard_owner
  FROM pg_catalog.pg_proc AS p
  JOIN pg_catalog.pg_roles AS r ON r.oid = p.proowner
  WHERE p.oid = to_regprocedure('public.ofoq_client_dashboard()');
  IF v_dashboard_owner IS DISTINCT FROM current_user THEN
    RAISE EXCEPTION 'Ofoq project-plan migration stopped: run it as the owner of public.ofoq_client_dashboard() so the replacement keeps the same SECURITY DEFINER role';
  END IF;
END
$ofoq_project_plan_preflight$;

-- The plan table holds internal review notes and the approval trail: no direct
-- client access at all.
ALTER TABLE public.project_plans ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.project_plans FROM PUBLIC, anon, authenticated;

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
        'plan', (
          SELECT jsonb_build_object(
            'version', pl.version,
            'status', pl.status,
            'approvedAt', pl.approved_at,
            'summary', pl.summary,
            'phases', coalesce((
              SELECT jsonb_agg(jsonb_build_object(
                'key', elem.value->>'key',
                'title', elem.value->>'title',
                'dueDate', elem.value->>'dueDate',
                'tasks', coalesce((
                  SELECT jsonb_agg(jsonb_build_object(
                    'title', t.title, 'status', t.status, 'dueDate', t.due_date
                  ) ORDER BY t.sort_order, t.created_at)
                  FROM public.project_tasks AS t
                  WHERE t.project_id = p.id
                    AND t.visibility = 'CLIENT'
                    AND t.phase_key = elem.value->>'key'
                ), '[]'::jsonb)
              ) ORDER BY elem.ord)
              FROM jsonb_array_elements(pl.phases::jsonb) WITH ORDINALITY AS elem(value, ord)
              WHERE EXISTS (
                SELECT 1
                FROM public.project_tasks AS visible_task
                WHERE visible_task.project_id = p.id
                  AND visible_task.visibility = 'CLIENT'
                  AND visible_task.phase_key = elem.value->>'key'
              )
            ), '[]'::jsonb)
          )
          FROM public.project_plans AS pl
          WHERE pl.project_id = p.id AND pl.status = 'APPROVED'
          ORDER BY pl.version DESC
          LIMIT 1
        ),
        'tasks', coalesce((
          SELECT jsonb_agg(jsonb_build_object(
            'id', t.id, 'title', t.title, 'titleEn', t.title_en,
            'status', t.status, 'dueDate', t.due_date, 'sortOrder', t.sort_order
          ) ORDER BY t.sort_order)
          FROM public.project_tasks AS t
          WHERE t.project_id = p.id AND t.visibility = 'CLIENT'
            -- A task of a plan the owner has not approved is still a
            -- proposal: it never reaches the client.
            AND (
              t.phase_key IS NULL
              OR EXISTS (
                SELECT 1 FROM public.project_plans AS approved_plan
                WHERE approved_plan.project_id = p.id
                  AND approved_plan.status = 'APPROVED'
              )
            )
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
      -- Positive allowlist of published offer states. DRAFT is internal
      -- (including guided service requests awaiting staff review), and
      -- EXPIRED/CANCELLED were already hidden by the original dashboard.
      AND o.status IN ('SENT', 'APPROVED', 'REJECTED')
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

-- The client-safe view of ONE project. The caller must own the project:
-- the customer is resolved from auth.uid(), never from a parameter.
CREATE OR REPLACE FUNCTION public.ofoq_client_project_detail(p_project_id text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_user_id text := (SELECT auth.uid())::text;
  v_customer_id text;
  v_project public.projects%ROWTYPE;
  v_tasks jsonb;
  v_plan jsonb;
  v_progress integer;
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
    RAISE EXCEPTION 'No client profile is linked to this account' USING ERRCODE = '42501';
  END IF;

  SELECT p.* INTO v_project
  FROM public.projects AS p
  WHERE p.id = p_project_id AND p.customer_id = v_customer_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Project not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', t.id, 'title', t.title, 'titleEn', t.title_en, 'status', t.status,
    'dueDate', t.due_date, 'completedAt', t.completed_at,
    'phaseKey', t.phase_key, 'sortOrder', t.sort_order
  ) ORDER BY t.sort_order, t.created_at), '[]'::jsonb)
  INTO v_tasks
  FROM public.project_tasks AS t
  WHERE t.project_id = v_project.id AND t.visibility = 'CLIENT'
    AND (
      t.phase_key IS NULL
      OR EXISTS (
        SELECT 1 FROM public.project_plans AS approved_plan
        WHERE approved_plan.project_id = v_project.id
          AND approved_plan.status = 'APPROVED'
      )
    );

  SELECT round(
           100.0 * count(*) FILTER (WHERE t.status = 'DONE')
           / NULLIF(count(*), 0)
         )::integer
  INTO v_progress
  FROM public.project_tasks AS t
  WHERE t.project_id = v_project.id AND t.visibility = 'CLIENT'
    AND (
      t.phase_key IS NULL
      OR EXISTS (
        SELECT 1 FROM public.project_plans AS approved_plan
        WHERE approved_plan.project_id = v_project.id
          AND approved_plan.status = 'APPROVED'
      )
    );

  SELECT jsonb_build_object(
    'version', pl.version,
    'status', pl.status,
    'approvedAt', pl.approved_at,
    'summary', pl.summary,
    'phases', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'key', elem.value->>'key',
        'title', elem.value->>'title',
        'dueDate', elem.value->>'dueDate',
        'tasks', coalesce((
          SELECT jsonb_agg(jsonb_build_object(
            'title', t.title, 'status', t.status, 'dueDate', t.due_date
          ) ORDER BY t.sort_order, t.created_at)
          FROM public.project_tasks AS t
          WHERE t.project_id = v_project.id
            AND t.visibility = 'CLIENT'
            AND t.phase_key = elem.value->>'key'
        ), '[]'::jsonb)
      ) ORDER BY elem.ord)
      FROM jsonb_array_elements(pl.phases::jsonb) WITH ORDINALITY AS elem(value, ord)
      WHERE EXISTS (
        SELECT 1
        FROM public.project_tasks AS visible_task
        WHERE visible_task.project_id = v_project.id
          AND visible_task.visibility = 'CLIENT'
          AND visible_task.phase_key = elem.value->>'key'
      )
    ), '[]'::jsonb)
  )
  INTO v_plan
  FROM public.project_plans AS pl
  WHERE pl.project_id = v_project.id AND pl.status = 'APPROVED'
  ORDER BY pl.version DESC
  LIMIT 1;

  RETURN jsonb_build_object(
    'project', jsonb_build_object(
      'id', v_project.id,
      'code', v_project.code,
      'title', v_project.title,
      'titleEn', v_project.title_en,
      'brief', v_project.brief,
      'status', v_project.status,
      'progress', coalesce(v_progress, 0),
      'currency', v_project.currency,
      'startDate', v_project.start_date,
      'dueDate', v_project.due_date,
      'completedAt', v_project.completed_at
    ),
    'tasks', v_tasks,
    'plan', v_plan
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.ofoq_client_project_detail(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ofoq_client_project_detail(text) TO authenticated;

-- The dashboard stays callable only by signed-in users.
REVOKE ALL ON FUNCTION public.ofoq_client_dashboard() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ofoq_client_dashboard() TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- Mark the generated migrations as applied so `npm run db:migrate` is safe
-- after this manual SQL setup. Checksums are computed from the generated files.
INSERT INTO public._migrations (id, name, checksum, applied_at, duration_ms)
VALUES
  ('0001', 'core', '3500558b628b106db34ce80ac5bbbf0c6579bdaa8900e20f52d755f21418c658', CURRENT_TIMESTAMP::text, 0),
  ('0002', 'agents growth', '89dbf052a975332b4dae8a9f0dda7258d0afd507db362c7ad0284d0208d0df12', CURRENT_TIMESTAMP::text, 0),
  ('0004', 'project plans', 'd60a5fb83bff08716645d92ecbd893ef77f7bcf4242843ce7ae2f839bb969b02', CURRENT_TIMESTAMP::text, 0),
  ('0005', 'enable rls', '06e2cb6e9de36bcafac391e51862d7ecc2068f78929649cf87d41653e54d2ccd', CURRENT_TIMESTAMP::text, 0),
  ('0006', 'offers nullable request price', '47c96e41639c7d6c312f68cdaa54658dc70ce3d2298ee8e2b94e2a5a2977e3eb', CURRENT_TIMESTAMP::text, 0)
ON CONFLICT (id) DO NOTHING;
