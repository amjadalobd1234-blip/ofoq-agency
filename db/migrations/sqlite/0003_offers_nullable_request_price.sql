-- New SQLite migration; keep 0001_core.sql and 0002_agents_growth.sql immutable.
-- @sqlite-foreign-keys-off
-- @postgres-skip: this SQLite table rebuild cannot be translated to PostgreSQL.
-- @postgres-name: offers nullable request price
-- @postgres-equivalent: ALTER TABLE public.offers ALTER COLUMN subtotal_minor DROP NOT NULL;
-- @postgres-equivalent: ALTER TABLE public.offers ALTER COLUMN total_minor DROP NOT NULL;
-- Supabase additionally applies the ownership/RPC hardening in migration 0010.
--
-- SQLite has no ALTER COLUMN DROP NOT NULL. Rebuild the parent table while
-- foreign-key enforcement is temporarily disabled by the migration runner.
-- Every offer row and its child rows are preserved; PRAGMA foreign_key_check
-- runs before commit, so a failed copy/rebuild rolls back as one transaction.

CREATE TABLE offers_new (
  id                  TEXT PRIMARY KEY,
  code                TEXT NOT NULL UNIQUE,
  customer_id         TEXT NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  project_id          TEXT REFERENCES projects (id) ON DELETE SET NULL,
  status              TEXT NOT NULL CHECK (status IN ('DRAFT', 'SENT', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED')),
  currency            TEXT NOT NULL DEFAULT 'USD',
  subtotal_minor      INTEGER DEFAULT 0,
  discount_minor      INTEGER NOT NULL DEFAULT 0,
  total_minor         INTEGER DEFAULT 0,
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

INSERT INTO offers_new (
  id, code, customer_id, project_id, status, currency,
  subtotal_minor, discount_minor, total_minor, internal_cost_minor, margin_pct,
  valid_until, pricing_reason, pricing_breakdown, client_note, internal_note,
  created_by_agent, created_by_user_id, approved_at, rejected_at, is_demo,
  created_at, updated_at
)
SELECT
  id, code, customer_id, project_id, status, currency,
  subtotal_minor, discount_minor, total_minor, internal_cost_minor, margin_pct,
  valid_until, pricing_reason, pricing_breakdown, client_note, internal_note,
  created_by_agent, created_by_user_id, approved_at, rejected_at, is_demo,
  created_at, updated_at
FROM offers;

DROP TABLE offers;
ALTER TABLE offers_new RENAME TO offers;
CREATE INDEX IF NOT EXISTS idx_offers_customer ON offers (customer_id, status);
