-- =============================================================================
--  Ofoq platform — core schema (migration 0001)
-- -----------------------------------------------------------------------------
--  Written against a portable SQL subset shared by SQLite (default) and
--  PostgreSQL: TEXT / INTEGER / REAL columns, TEXT primary keys holding
--  application-generated UUIDs, ISO-8601 TEXT timestamps and monetary values in
--  integer minor units (cents/fils) — never floating point.
--
--  The migration runner rewrites the type tokens for PostgreSQL
--  (see src/lib/db/migrate.ts → transformForDialect).
--  Every timestamp column is written explicitly by the application layer.
-- =============================================================================

-- ---------------------------------------------------------------- identity ---

CREATE TABLE users (
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
  is_demo            INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE INDEX idx_users_role_status ON users (role, status);

CREATE TABLE sessions (
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

CREATE INDEX idx_sessions_user ON sessions (user_id, expires_at);

CREATE TABLE verification_tokens (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK (type IN ('EMAIL_VERIFY', 'PASSWORD_RESET')),
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  meta        TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX idx_verification_user_type ON verification_tokens (user_id, type);

CREATE TABLE login_attempts (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  ip          TEXT,
  success     INTEGER NOT NULL DEFAULT 0,
  reason      TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX idx_login_attempts_email ON login_attempts (email, created_at);

-- --------------------------------------------------------------- customers ---

CREATE TABLE customers (
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
  is_demo        INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE INDEX idx_customers_status ON customers (status, created_at);
CREATE INDEX idx_customers_user ON customers (user_id);

-- Facts captured from conversations/forms. Each fact keeps its provenance so a
-- human can audit or correct what an agent inferred.
CREATE TABLE customer_facts (
  id           TEXT PRIMARY KEY,
  customer_id  TEXT NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  fact_key     TEXT NOT NULL,
  fact_value   TEXT NOT NULL,
  source       TEXT NOT NULL CHECK (source IN ('CHAT', 'FORM', 'AGENT', 'STAFF', 'IMPORT')),
  confidence   REAL NOT NULL DEFAULT 1,
  verified     INTEGER NOT NULL DEFAULT 0,
  recorded_by  TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (customer_id, fact_key)
);

-- ---------------------------------------------------------------- services ---

CREATE TABLE services (
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
  base_price_minor             INTEGER NOT NULL DEFAULT 0,
  min_price_minor              INTEGER NOT NULL DEFAULT 0,
  currency                     TEXT NOT NULL DEFAULT 'USD',
  delivery_days                INTEGER NOT NULL DEFAULT 7,
  revisions_included           INTEGER NOT NULL DEFAULT 2,
  complexity_factor            REAL NOT NULL DEFAULT 1,
  requires_approval_above_minor INTEGER,
  is_active                    INTEGER NOT NULL DEFAULT 1,
  sort_order                   INTEGER NOT NULL DEFAULT 0,
  pricing_config               TEXT,
  cancellation_policy          TEXT,
  created_at                   TEXT NOT NULL,
  updated_at                   TEXT NOT NULL
);

CREATE INDEX idx_services_active ON services (is_active, sort_order);

-- ---------------------------------------------------------------- projects ---

CREATE TABLE projects (
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
  amount_total_minor INTEGER NOT NULL DEFAULT 0,
  internal_cost_minor INTEGER NOT NULL DEFAULT 0,
  margin_pct         REAL,
  country            TEXT,
  progress           INTEGER NOT NULL DEFAULT 0,
  risk_level         TEXT CHECK (risk_level IN ('LOW', 'MEDIUM', 'HIGH')),
  start_date         TEXT,
  due_date           TEXT,
  completed_at       TEXT,
  ai_plan            TEXT,
  created_by_user_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_by_agent   TEXT,
  is_demo            INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE INDEX idx_projects_customer ON projects (customer_id, status);
CREATE INDEX idx_projects_status ON projects (status, due_date);

CREATE TABLE project_services (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  service_id       TEXT REFERENCES services (id) ON DELETE SET NULL,
  name_snapshot    TEXT NOT NULL,
  quantity         REAL NOT NULL DEFAULT 1,
  unit_price_minor INTEGER NOT NULL DEFAULT 0,
  billing_type     TEXT NOT NULL CHECK (billing_type IN ('ONE_TIME', 'SUBSCRIPTION')),
  months           INTEGER,
  notes            TEXT,
  created_at       TEXT NOT NULL
);

CREATE INDEX idx_project_services_project ON project_services (project_id);

CREATE TABLE project_tasks (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  title          TEXT NOT NULL,
  title_en       TEXT,
  description    TEXT,
  status         TEXT NOT NULL CHECK (status IN ('TODO', 'IN_PROGRESS', 'BLOCKED', 'REVIEW', 'DONE')),
  visibility     TEXT NOT NULL DEFAULT 'CLIENT' CHECK (visibility IN ('CLIENT', 'INTERNAL')),
  sort_order     INTEGER NOT NULL DEFAULT 0,
  due_date       TEXT,
  completed_at   TEXT,
  assigned_agent TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE INDEX idx_project_tasks_project ON project_tasks (project_id, sort_order);

-- ------------------------------------------------------------------ offers ---

CREATE TABLE offers (
  id                  TEXT PRIMARY KEY,
  code                TEXT NOT NULL UNIQUE,
  customer_id         TEXT NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  project_id          TEXT REFERENCES projects (id) ON DELETE SET NULL,
  status              TEXT NOT NULL CHECK (status IN ('DRAFT', 'SENT', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED')),
  currency            TEXT NOT NULL DEFAULT 'USD',
  subtotal_minor      INTEGER NOT NULL DEFAULT 0,
  discount_minor      INTEGER NOT NULL DEFAULT 0,
  total_minor         INTEGER NOT NULL DEFAULT 0,
  internal_cost_minor INTEGER NOT NULL DEFAULT 0,
  margin_pct          REAL,
  valid_until         TEXT,
  pricing_reason      TEXT,
  pricing_breakdown   TEXT,
  client_note         TEXT,
  internal_note       TEXT,
  created_by_agent    TEXT,
  created_by_user_id  TEXT REFERENCES users (id) ON DELETE SET NULL,
  approved_at         TEXT,
  rejected_at         TEXT,
  is_demo             INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE INDEX idx_offers_customer ON offers (customer_id, status);

CREATE TABLE offer_items (
  id                TEXT PRIMARY KEY,
  offer_id          TEXT NOT NULL REFERENCES offers (id) ON DELETE CASCADE,
  service_id        TEXT REFERENCES services (id) ON DELETE SET NULL,
  description_ar    TEXT NOT NULL,
  description_en    TEXT,
  quantity          REAL NOT NULL DEFAULT 1,
  unit_price_minor  INTEGER NOT NULL DEFAULT 0,
  billing_type      TEXT NOT NULL CHECK (billing_type IN ('ONE_TIME', 'SUBSCRIPTION')),
  months            INTEGER,
  total_minor       INTEGER NOT NULL DEFAULT 0,
  sort_order        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_offer_items_offer ON offer_items (offer_id);

-- -------------------------------------------------------- money & billing ---

CREATE TABLE invoices (
  id                       TEXT PRIMARY KEY,
  number                   TEXT NOT NULL UNIQUE,
  customer_id              TEXT NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  project_id               TEXT REFERENCES projects (id) ON DELETE SET NULL,
  offer_id                 TEXT REFERENCES offers (id) ON DELETE SET NULL,
  subscription_id          TEXT,
  currency                 TEXT NOT NULL DEFAULT 'USD',
  subtotal_minor           INTEGER NOT NULL DEFAULT 0,
  tax_minor                INTEGER NOT NULL DEFAULT 0,
  total_minor              INTEGER NOT NULL DEFAULT 0,
  amount_paid_minor        INTEGER NOT NULL DEFAULT 0,
  refunded_minor           INTEGER NOT NULL DEFAULT 0,
  status                   TEXT NOT NULL CHECK (status IN ('DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'CANCELLED', 'REFUNDED')),
  issued_at                TEXT,
  due_at                   TEXT,
  paid_at                  TEXT,
  notes_client             TEXT,
  internal_note            TEXT,
  policy_snapshot          TEXT,
  is_demo                  INTEGER NOT NULL DEFAULT 0,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL
);

CREATE INDEX idx_invoices_customer ON invoices (customer_id, status);
CREATE INDEX idx_invoices_due ON invoices (status, due_at);

-- Payments never store card data. Card payments are only recorded as a provider
-- reference produced by the payment gateway.
CREATE TABLE payments (
  id                  TEXT PRIMARY KEY,
  invoice_id          TEXT REFERENCES invoices (id) ON DELETE SET NULL,
  customer_id         TEXT NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  subscription_id     TEXT REFERENCES subscriptions (id) ON DELETE SET NULL,
  amount_minor        INTEGER NOT NULL,
  refunded_minor      INTEGER NOT NULL DEFAULT 0,
  currency            TEXT NOT NULL DEFAULT 'USD',
  method              TEXT NOT NULL CHECK (method IN ('MANUAL_TRANSFER', 'CASH', 'CARD_ONLINE', 'WALLET', 'OTHER')),
  provider            TEXT NOT NULL DEFAULT 'manual',
  provider_ref        TEXT,
  status              TEXT NOT NULL CHECK (status IN ('PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED')),
  paid_at             TEXT,
  recorded_by_user_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  note                TEXT,
  is_demo             INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE INDEX idx_payments_customer ON payments (customer_id, status);

CREATE TABLE subscriptions (
  id                     TEXT PRIMARY KEY,
  customer_id            TEXT NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  service_id             TEXT REFERENCES services (id) ON DELETE SET NULL,
  project_id             TEXT REFERENCES projects (id) ON DELETE SET NULL,
  plan_name              TEXT NOT NULL,
  amount_minor           INTEGER NOT NULL DEFAULT 0,
  currency               TEXT NOT NULL DEFAULT 'USD',
  interval               TEXT NOT NULL CHECK (interval IN ('MONTHLY', 'QUARTERLY', 'YEARLY')),
  interval_count         INTEGER NOT NULL DEFAULT 1,
  status                 TEXT NOT NULL CHECK (status IN ('ACTIVE', 'PAST_DUE', 'PAUSED', 'CANCELLED', 'EXPIRED')),
  started_at             TEXT NOT NULL,
  current_period_start   TEXT NOT NULL,
  current_period_end     TEXT NOT NULL,
  next_renewal_at        TEXT,
  auto_renew             INTEGER NOT NULL DEFAULT 0,
  cancel_at_period_end   INTEGER NOT NULL DEFAULT 0,
  cancelled_at           TEXT,
  cancellation_reason    TEXT,
  policy_snapshot        TEXT,
  is_demo                INTEGER NOT NULL DEFAULT 0,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);

CREATE INDEX idx_subscriptions_customer ON subscriptions (customer_id, status);
CREATE INDEX idx_subscriptions_renewal ON subscriptions (status, next_renewal_at);

-- ----------------------------------------------------------- conversations ---

CREATE TABLE conversations (
  id                  TEXT PRIMARY KEY,
  customer_id         TEXT NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  channel             TEXT NOT NULL CHECK (channel IN ('WEB', 'EMAIL', 'WHATSAPP', 'PHONE', 'SYSTEM')),
  subject             TEXT,
  status              TEXT NOT NULL CHECK (status IN ('OPEN', 'PENDING', 'CLOSED')),
  assigned_to_user_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  external_ref        TEXT,
  unread_for_client   INTEGER NOT NULL DEFAULT 0,
  unread_for_staff    INTEGER NOT NULL DEFAULT 0,
  last_message_at     TEXT,
  is_demo             INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE INDEX idx_conversations_customer ON conversations (customer_id, status);
CREATE INDEX idx_conversations_channel ON conversations (channel, last_message_at);

CREATE TABLE messages (
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
  is_demo             INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_messages_conversation ON messages (conversation_id, created_at);

-- ------------------------------------------------------------------- files ---

CREATE TABLE files (
  id                TEXT PRIMARY KEY,
  customer_id       TEXT NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  project_id        TEXT REFERENCES projects (id) ON DELETE SET NULL,
  offer_id          TEXT REFERENCES offers (id) ON DELETE SET NULL,
  uploader_type     TEXT NOT NULL CHECK (uploader_type IN ('CLIENT', 'STAFF', 'AGENT', 'SYSTEM')),
  uploader_user_id  TEXT REFERENCES users (id) ON DELETE SET NULL,
  name              TEXT NOT NULL,
  kind              TEXT,
  mime              TEXT,
  size_bytes        INTEGER NOT NULL DEFAULT 0,
  storage_provider  TEXT NOT NULL DEFAULT 'local',
  storage_key       TEXT NOT NULL,
  visibility        TEXT NOT NULL DEFAULT 'CLIENT' CHECK (visibility IN ('CLIENT', 'INTERNAL')),
  checksum          TEXT,
  is_demo           INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL
);

CREATE INDEX idx_files_customer ON files (customer_id, created_at);
CREATE INDEX idx_files_project ON files (project_id);

-- ----------------------------------------------------------------- reviews ---

CREATE TABLE reviews (
  id             TEXT PRIMARY KEY,
  customer_id    TEXT NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  project_id     TEXT REFERENCES projects (id) ON DELETE SET NULL,
  rating         INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  satisfaction   TEXT,
  liked          TEXT,
  improve        TEXT,
  wants_more     INTEGER NOT NULL DEFAULT 0,
  note           TEXT,
  status         TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  published      INTEGER NOT NULL DEFAULT 0,
  published_name TEXT,
  published_at   TEXT,
  source         TEXT NOT NULL DEFAULT 'PORTAL',
  is_demo        INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE INDEX idx_reviews_public ON reviews (published, published_at);

-- ------------------------------------------------------- activity & config ---

CREATE TABLE activities (
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
  is_demo        INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL
);

CREATE INDEX idx_activities_created ON activities (created_at);
CREATE INDEX idx_activities_customer ON activities (customer_id, created_at);
CREATE INDEX idx_activities_entity ON activities (entity_type, entity_id);

CREATE TABLE settings (
  key                TEXT PRIMARY KEY,
  value              TEXT NOT NULL,
  value_type         TEXT NOT NULL DEFAULT 'string' CHECK (value_type IN ('string', 'number', 'boolean', 'json')),
  updated_by_user_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  updated_at         TEXT NOT NULL
);

CREATE TABLE rate_limits (
  key           TEXT PRIMARY KEY,
  window_start  INTEGER NOT NULL,
  count         INTEGER NOT NULL DEFAULT 0,
  blocked_until INTEGER
);
