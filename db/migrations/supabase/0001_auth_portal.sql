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
