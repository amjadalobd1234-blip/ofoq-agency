-- =============================================================================
-- Ofoq — Row Level Security policies for the client-portal tables
-- -----------------------------------------------------------------------------
-- Run this in the Supabase SQL Editor AFTER docs/setup/supabase-setup.sql.
-- It is safe to re-run: every policy is dropped and recreated, every grant is
-- idempotent.
--
-- IMPORTANT CONTEXT — read before assuming this fixes "Authentication required"
-- -----------------------------------------------------------------------------
-- `/api/dashboard` does NOT read these tables directly with `supabase.from(...)`.
-- It calls the Postgres function `public.ofoq_client_dashboard()` (defined in
-- docs/setup/supabase-setup.sql), which is `SECURITY DEFINER` — it already
-- bypasses RLS internally and does its own ownership check against
-- `auth.uid()`. That function is the real data path for the dashboard today.
--
-- The exact message in the screenshot — "Authentication required" — is
-- produced by src/lib/supabase/route-auth.ts BEFORE any table or RPC is
-- touched, whenever `supabase.auth.getUser()` (running with the request's
-- cookies) returns no user. That is a *session/cookie* problem, not a missing
-- policy: if RLS were the blocker the error would instead be
-- "Unable to load platform data right now." (502, from rpcFailureResponse)
-- with Postgres code 42501, or "Your session is not active..." (401,
-- ERRCODE 28000) coming back from inside ofoq_client_dashboard() itself.
--
-- This file still matters for two reasons:
--  1. Defense in depth — if any current/future code ever queries these tables
--     directly via `supabase.from('projects').select(...)` instead of the
--     RPC, these policies make sure a signed-in client can only ever see
--     their *own* rows, never another customer's.
--  2. It is the schema-level safety net the task asked for. Apply it once the
--     session/cookie issue (see src/middleware.ts) is also fixed.
--
-- All tables already have `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` from
-- supabase-setup.sql; the statements below are repeated defensively since
-- this file is meant to be runnable on its own.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Helper: is the current JWT a staff member (OWNER/PARTNER, ACTIVE)?
-- Already created by supabase-setup.sql; recreated here so this file can be
-- pasted standalone into the SQL editor.
-- ---------------------------------------------------------------------------
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

-- ===========================================================================
-- users
-- ===========================================================================
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users_self_select" ON public.users;
CREATE POLICY "users_self_select" ON public.users
  FOR SELECT TO authenticated
  USING (id = (SELECT auth.uid())::text OR email = (SELECT auth.jwt() ->> 'email') OR public.ofoq_is_staff());

DROP POLICY IF EXISTS "users_self_update" ON public.users;
CREATE POLICY "users_self_update" ON public.users
  FOR UPDATE TO authenticated
  USING (id = (SELECT auth.uid())::text OR email = (SELECT auth.jwt() ->> 'email'))
  WITH CHECK (id = (SELECT auth.uid())::text OR email = (SELECT auth.jwt() ->> 'email'));

GRANT SELECT (id, email, name, role, status, locale, phone, country, avatar_url,
              email_verified_at, created_at, updated_at)
  ON TABLE public.users TO authenticated;
GRANT UPDATE (name, locale, phone, country, avatar_url, updated_at)
  ON TABLE public.users TO authenticated;

-- ===========================================================================
-- customers (the client's own profile row — one per Supabase Auth user)
-- ===========================================================================
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "customers_self_select" ON public.customers;
CREATE POLICY "customers_self_select" ON public.customers
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid())::text OR public.ofoq_is_staff());

DROP POLICY IF EXISTS "customers_self_update" ON public.customers;
CREATE POLICY "customers_self_update" ON public.customers
  FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid())::text OR public.ofoq_is_staff())
  WITH CHECK (user_id = (SELECT auth.uid())::text OR public.ofoq_is_staff());

GRANT SELECT ON TABLE public.customers TO authenticated;
GRANT UPDATE (company_name, contact_name, phone, country, city, goals, needs, updated_at)
  ON TABLE public.customers TO authenticated;

-- ===========================================================================
-- projects (owned via customers.user_id)
-- ===========================================================================
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "projects_owner_select" ON public.projects;
CREATE POLICY "projects_owner_select" ON public.projects
  FOR SELECT TO authenticated
  USING (
    public.ofoq_is_staff()
    OR EXISTS (
      SELECT 1 FROM public.customers AS c
      WHERE c.id = projects.customer_id AND c.user_id = (SELECT auth.uid())::text
    )
  );

GRANT SELECT ON TABLE public.projects TO authenticated;

-- ---------------------------------------------------------------------------
-- project_tasks (only rows marked visible to the client)
-- ---------------------------------------------------------------------------
ALTER TABLE public.project_tasks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "project_tasks_owner_select" ON public.project_tasks;
CREATE POLICY "project_tasks_owner_select" ON public.project_tasks
  FOR SELECT TO authenticated
  USING (
    public.ofoq_is_staff()
    OR (
      visibility = 'CLIENT'
      AND EXISTS (
        SELECT 1
        FROM public.projects AS p
        JOIN public.customers AS c ON c.id = p.customer_id
        WHERE p.id = project_tasks.project_id AND c.user_id = (SELECT auth.uid())::text
      )
    )
  );

GRANT SELECT ON TABLE public.project_tasks TO authenticated;

-- ===========================================================================
-- offers / offer_items
-- ===========================================================================
ALTER TABLE public.offers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "offers_owner_select" ON public.offers;
CREATE POLICY "offers_owner_select" ON public.offers
  FOR SELECT TO authenticated
  USING (
    public.ofoq_is_staff()
    OR EXISTS (
      SELECT 1 FROM public.customers AS c
      WHERE c.id = offers.customer_id AND c.user_id = (SELECT auth.uid())::text
    )
  );

GRANT SELECT ON TABLE public.offers TO authenticated;

ALTER TABLE public.offer_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "offer_items_owner_select" ON public.offer_items;
CREATE POLICY "offer_items_owner_select" ON public.offer_items
  FOR SELECT TO authenticated
  USING (
    public.ofoq_is_staff()
    OR EXISTS (
      SELECT 1
      FROM public.offers AS o
      JOIN public.customers AS c ON c.id = o.customer_id
      WHERE o.id = offer_items.offer_id AND c.user_id = (SELECT auth.uid())::text
    )
  );

GRANT SELECT ON TABLE public.offer_items TO authenticated;

-- ===========================================================================
-- invoices
-- ===========================================================================
ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "invoices_owner_select" ON public.invoices;
CREATE POLICY "invoices_owner_select" ON public.invoices
  FOR SELECT TO authenticated
  USING (
    public.ofoq_is_staff()
    OR EXISTS (
      SELECT 1 FROM public.customers AS c
      WHERE c.id = invoices.customer_id AND c.user_id = (SELECT auth.uid())::text
    )
  );

GRANT SELECT ON TABLE public.invoices TO authenticated;

-- ===========================================================================
-- payments
-- ===========================================================================
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "payments_owner_select" ON public.payments;
CREATE POLICY "payments_owner_select" ON public.payments
  FOR SELECT TO authenticated
  USING (
    public.ofoq_is_staff()
    OR EXISTS (
      SELECT 1 FROM public.customers AS c
      WHERE c.id = payments.customer_id AND c.user_id = (SELECT auth.uid())::text
    )
  );

GRANT SELECT ON TABLE public.payments TO authenticated;

-- ===========================================================================
-- subscriptions
-- ===========================================================================
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "subscriptions_owner_select" ON public.subscriptions;
CREATE POLICY "subscriptions_owner_select" ON public.subscriptions
  FOR SELECT TO authenticated
  USING (
    public.ofoq_is_staff()
    OR EXISTS (
      SELECT 1 FROM public.customers AS c
      WHERE c.id = subscriptions.customer_id AND c.user_id = (SELECT auth.uid())::text
    )
  );

GRANT SELECT ON TABLE public.subscriptions TO authenticated;

-- ===========================================================================
-- campaigns / campaign_metrics_daily
-- ===========================================================================
ALTER TABLE public.campaigns ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "campaigns_owner_select" ON public.campaigns;
CREATE POLICY "campaigns_owner_select" ON public.campaigns
  FOR SELECT TO authenticated
  USING (
    public.ofoq_is_staff()
    OR EXISTS (
      SELECT 1 FROM public.customers AS c
      WHERE c.id = campaigns.customer_id AND c.user_id = (SELECT auth.uid())::text
    )
  );

GRANT SELECT ON TABLE public.campaigns TO authenticated;

ALTER TABLE public.campaign_metrics_daily ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "campaign_metrics_owner_select" ON public.campaign_metrics_daily;
CREATE POLICY "campaign_metrics_owner_select" ON public.campaign_metrics_daily
  FOR SELECT TO authenticated
  USING (
    public.ofoq_is_staff()
    OR EXISTS (
      SELECT 1
      FROM public.campaigns AS cm
      JOIN public.customers AS c ON c.id = cm.customer_id
      WHERE cm.id = campaign_metrics_daily.campaign_id AND c.user_id = (SELECT auth.uid())::text
    )
  );

GRANT SELECT ON TABLE public.campaign_metrics_daily TO authenticated;

-- ===========================================================================
-- reports (only ones already sent to the client)
-- ===========================================================================
ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "reports_owner_select" ON public.reports;
CREATE POLICY "reports_owner_select" ON public.reports
  FOR SELECT TO authenticated
  USING (
    public.ofoq_is_staff()
    OR (
      status = 'SENT'
      AND EXISTS (
        SELECT 1 FROM public.customers AS c
        WHERE c.id = reports.customer_id AND c.user_id = (SELECT auth.uid())::text
      )
    )
  );

GRANT SELECT ON TABLE public.reports TO authenticated;

-- ===========================================================================
-- files (only ones marked visible to the client)
-- ===========================================================================
ALTER TABLE public.files ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "files_owner_select" ON public.files;
CREATE POLICY "files_owner_select" ON public.files
  FOR SELECT TO authenticated
  USING (
    public.ofoq_is_staff()
    OR (
      visibility = 'CLIENT'
      AND EXISTS (
        SELECT 1 FROM public.customers AS c
        WHERE c.id = files.customer_id AND c.user_id = (SELECT auth.uid())::text
      )
    )
  );

GRANT SELECT ON TABLE public.files TO authenticated;

-- ===========================================================================
-- conversations / messages (used by the chat RPCs; included for completeness)
-- ===========================================================================
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "conversations_owner_select" ON public.conversations;
CREATE POLICY "conversations_owner_select" ON public.conversations
  FOR SELECT TO authenticated
  USING (
    public.ofoq_is_staff()
    OR EXISTS (
      SELECT 1 FROM public.customers AS c
      WHERE c.id = conversations.customer_id AND c.user_id = (SELECT auth.uid())::text
    )
  );

GRANT SELECT ON TABLE public.conversations TO authenticated;

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "messages_owner_select" ON public.messages;
CREATE POLICY "messages_owner_select" ON public.messages
  FOR SELECT TO authenticated
  USING (
    public.ofoq_is_staff()
    OR EXISTS (
      SELECT 1
      FROM public.conversations AS conv
      JOIN public.customers AS c ON c.id = conv.customer_id
      WHERE conv.id = messages.conversation_id AND c.user_id = (SELECT auth.uid())::text
    )
  );

GRANT SELECT ON TABLE public.messages TO authenticated;

-- ===========================================================================
-- reviews
-- ===========================================================================
ALTER TABLE public.reviews ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "reviews_owner_select" ON public.reviews;
CREATE POLICY "reviews_owner_select" ON public.reviews
  FOR SELECT TO authenticated
  USING (
    public.ofoq_is_staff()
    OR EXISTS (
      SELECT 1 FROM public.customers AS c
      WHERE c.id = reviews.customer_id AND c.user_id = (SELECT auth.uid())::text
    )
  );

DROP POLICY IF EXISTS "reviews_owner_insert" ON public.reviews;
CREATE POLICY "reviews_owner_insert" ON public.reviews
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.customers AS c
      WHERE c.id = reviews.customer_id AND c.user_id = (SELECT auth.uid())::text
    )
  );

GRANT SELECT, INSERT ON TABLE public.reviews TO authenticated;

-- ===========================================================================
-- Done.
-- ===========================================================================
-- Next step for the "Authentication required" symptom specifically: confirm
-- the browser is actually sending the Supabase session cookie to the
-- server. Open DevTools → Application → Cookies on your deployed origin
-- right after logging in and look for `sb-<project-ref>-auth-token` (and any
-- `.0`, `.1`, … chunks). If it is missing, the problem is in
-- src/middleware.ts / src/lib/supabase/browser.ts /
-- src/lib/supabase/server.ts, not in these policies — see the code changes
-- shipped alongside this file (session refresh middleware + explicit
-- cookie path + console.error logging of the real Supabase error).
