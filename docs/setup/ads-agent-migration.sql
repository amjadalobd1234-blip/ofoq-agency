-- =============================================================================
-- Ofoq · Supabase — الخطط الإعلانية في بوابة العميل (0012)
-- =============================================================================
-- خطوات التطبيق
-- --------------
-- 1) افتح Supabase Dashboard → مشروع الموقع → SQL Editor.
-- 2) شغّله بمالك دالة RPC الحالية (عادة postgres في Supabase SQL Editor)، وبعد
--    وجود مخطط الأساس و0001_auth_portal و0011_project_plans.sql.
--    الـ preflight أدناه يفشل بأمان عند غياب أي جدول/عمود/دالة متوقعة؛
--    لا تتجاوز الخطأ ولا تخمّن اختلاف المخطط.
-- 3) انسخ الملف كاملًا وشغّله مرة واحدة. الملف idempotent: ينشئ جدولي
--    ad_plans و ad_plan_results وعمود reports.ad_plan_id إن لم تكن موجودة،
--    ولا يحذف أو يعدّل أي بيانات تاريخية، ولا يتصل بأي حساب إعلاني.
-- 4) تحقّق من اكتمال التنفيذ بدون استثناء. إذا فشل الـ preflight، أوقف النشر
--    وافحص المخطط والصلاحيات قبل إعادة المحاولة.
-- 5) طبّق هذا الترحيل قبل نشر إصدار التطبيق الذي يعرض الخطة الإعلانية المعتمدة
--    للعميل. إن كنت تستخدم db:migrate على Postgres، شغّله أولاً (0005) ثم هذا الملف.
--    مسارات /api/ads* تحتاج DATABASE_URL في الإنتاج (نفس نمط المشاريع).
--    بوابة العميل تقرأ الخطة المعتمدة من ofoq_client_dashboard() بدون DATABASE_URL.
--
-- هذا الملف نسخة يدوية مطابقة للترحيل في
-- db/migrations/supabase/0012_ad_plans.sql.
-- وهو Migration جديد: لا يعيد كتابة أي Migration تاريخي ولا يتصل بقاعدة الإنتاج
-- تلقائيًا. ما الذي يضيفه:
--   * جدولا ad_plans و ad_plan_results + عمود reports.ad_plan_id؛
--   * RLS وسحب القراءة المباشرة: الخطة تُقدَّم عبر RPC يتحقق من ملكية العميل؛
--   * ofoq_client_dashboard تُعيد الآن adPlans بحالة APPROVED فقط، بلا ملاحظات
--     داخلية وبلا مسودات، وتخفي حملات DRAFT / PENDING_APPROVAL.
-- الوكيل استشاري: لا إطلاق ولا إنفاق ولا اتصال بـ Meta / Google / TikTok.
-- =============================================================================

-- =============================================================================
-- Ofoq — advertising plans for the client portal (وكيل الإعلانات).
-- -----------------------------------------------------------------------------
-- This is a NEW migration. It is NOT applied by this pull request: run it
-- manually in the Supabase SQL Editor (as the owner of the RPCs, normally
-- `postgres`) after the core schema and 0011_project_plans.sql.
--
-- What it adds:
--   * public.ad_plans / public.ad_plan_results (idempotent), plus reports.ad_plan_id.
--   * RLS + privilege hardening: no direct client read of plans, results or the
--     new reports column. Plans reach the portal only through the ownership-
--     checked RPC below.
--   * ofoq_client_dashboard() is replaced so it:
--       - returns APPROVED ads plans only (no drafts, no internal notes),
--       - hides DRAFT / PENDING_APPROVAL campaigns (those are internal),
--       - keeps the 0011 approved project-plan behaviour unchanged.
--
-- The preflight fails closed when required tables/columns/functions are
-- missing. This file is not applied to any Supabase project from the PR.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.ad_plans (
  id                  TEXT PRIMARY KEY,
  code                TEXT NOT NULL,
  customer_id         TEXT NOT NULL REFERENCES public.customers (id) ON DELETE CASCADE,
  project_id          TEXT REFERENCES public.projects (id) ON DELETE SET NULL,
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
  created_by_user_id  TEXT REFERENCES public.users (id) ON DELETE SET NULL,
  created_by_agent    TEXT,
  approved_by_user_id TEXT REFERENCES public.users (id) ON DELETE SET NULL,
  approved_at         TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ad_plans_family_version
  ON public.ad_plans (family_key, version);

CREATE INDEX IF NOT EXISTS idx_ad_plans_code
  ON public.ad_plans (code);

CREATE INDEX IF NOT EXISTS idx_ad_plans_customer
  ON public.ad_plans (customer_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_ad_plans_project
  ON public.ad_plans (project_id, status);

CREATE TABLE IF NOT EXISTS public.ad_plan_results (
  id                  TEXT PRIMARY KEY,
  ad_plan_id          TEXT NOT NULL REFERENCES public.ad_plans (id) ON DELETE CASCADE,
  customer_id         TEXT NOT NULL REFERENCES public.customers (id) ON DELETE CASCADE,
  result_date         TEXT NOT NULL,
  platform            TEXT NOT NULL DEFAULT 'ALL' CHECK (platform IN ('META_ADS', 'GOOGLE_ADS', 'TIKTOK', 'ALL')),
  spend_minor         BIGINT NOT NULL DEFAULT 0,
  impressions         BIGINT NOT NULL DEFAULT 0,
  clicks              BIGINT NOT NULL DEFAULT 0,
  messages            BIGINT NOT NULL DEFAULT 0,
  orders              BIGINT NOT NULL DEFAULT 0,
  source              TEXT NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL')),
  notes               TEXT,
  created_by_user_id  TEXT REFERENCES public.users (id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL,
  UNIQUE (ad_plan_id, result_date, platform)
);

CREATE INDEX IF NOT EXISTS idx_ad_plan_results_plan
  ON public.ad_plan_results (ad_plan_id, result_date);

CREATE INDEX IF NOT EXISTS idx_ad_plan_results_customer
  ON public.ad_plan_results (customer_id, result_date);

ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS ad_plan_id TEXT;

CREATE INDEX IF NOT EXISTS idx_reports_ad_plan
  ON public.reports (ad_plan_id, created_at);

-- The dashboard replacement keeps the 0011 project-plan query, which reads
-- these columns. Create them here so 0012 does not depend on 0011 having been
-- applied on a portal that already has project_tasks from the core schema.
ALTER TABLE public.project_tasks ADD COLUMN IF NOT EXISTS internal_note TEXT;
ALTER TABLE public.project_tasks ADD COLUMN IF NOT EXISTS phase_key TEXT;

DO $ofoq_ad_plan_preflight$
DECLARE
  v_missing text[];
  v_dashboard_owner text;
BEGIN
  IF to_regclass('public.users') IS NULL
     OR to_regclass('public.customers') IS NULL
     OR to_regclass('public.ad_plans') IS NULL
     OR to_regclass('public.ad_plan_results') IS NULL
     OR to_regclass('public.reports') IS NULL
     OR to_regclass('public.campaigns') IS NULL
     OR to_regclass('public.projects') IS NULL
     OR to_regclass('public.project_tasks') IS NULL
     OR to_regclass('public.project_plans') IS NULL THEN
    RAISE EXCEPTION 'Ofoq ads-plan migration stopped: one or more required public tables are missing; apply the core schema and 0011_project_plans.sql first';
  END IF;

  SELECT array_agg(required.column_name ORDER BY required.column_name)
    INTO v_missing
  FROM unnest(ARRAY[
    'users.id', 'users.status',
    'customers.id', 'customers.user_id',
    'ad_plans.id', 'ad_plans.customer_id', 'ad_plans.family_key', 'ad_plans.version',
    'ad_plans.status', 'ad_plans.body', 'ad_plans.internal_note', 'ad_plans.approved_at',
    'ad_plan_results.ad_plan_id', 'ad_plan_results.spend_minor',
    'reports.ad_plan_id', 'campaigns.status',
    'project_tasks.phase_key', 'project_plans.status'
  ]) AS required(column_name)
  WHERE NOT EXISTS (
    SELECT 1
    FROM information_schema.columns AS c
    WHERE c.table_schema = 'public'
      AND c.table_name = split_part(required.column_name, '.', 1)
      AND c.column_name = split_part(required.column_name, '.', 2)
  );

  IF coalesce(array_length(v_missing, 1), 0) > 0 THEN
    RAISE EXCEPTION 'Ofoq ads-plan migration stopped: required columns are missing: %', array_to_string(v_missing, ', ');
  END IF;

  IF to_regprocedure('auth.uid()') IS NULL THEN
    RAISE EXCEPTION 'Ofoq ads-plan migration stopped: auth.uid() is missing; verify the Supabase Auth schema before applying';
  END IF;

  IF to_regprocedure('public.ofoq_client_dashboard()') IS NULL THEN
    RAISE EXCEPTION 'Ofoq ads-plan migration stopped: public.ofoq_client_dashboard() is missing; apply/verify 0001_auth_portal.sql first';
  END IF;

  SELECT r.rolname INTO v_dashboard_owner
  FROM pg_catalog.pg_proc AS p
  JOIN pg_catalog.pg_roles AS r ON r.oid = p.proowner
  WHERE p.oid = to_regprocedure('public.ofoq_client_dashboard()');
  IF v_dashboard_owner IS DISTINCT FROM current_user THEN
    RAISE EXCEPTION 'Ofoq ads-plan migration stopped: run it as the owner of public.ofoq_client_dashboard() so the replacement keeps the same SECURITY DEFINER role';
  END IF;
END
$ofoq_ad_plan_preflight$;

ALTER TABLE public.ad_plans ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.ad_plans FROM PUBLIC, anon, authenticated;

ALTER TABLE public.ad_plan_results ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.ad_plan_results FROM PUBLIC, anon, authenticated;

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
  v_ad_plans jsonb;
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
      'campaigns', '[]'::jsonb, 'reports', '[]'::jsonb, 'files', '[]'::jsonb,
      'adPlans', '[]'::jsonb
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
  WHERE c.customer_id = v_customer_id
    -- Live campaigns only. DRAFT / PENDING_APPROVAL are internal proposals
    -- (same rule as ads plans: the client never sees unapproved work).
    AND c.status IN ('ACTIVE', 'PAUSED', 'COMPLETED');

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

  SELECT coalesce(jsonb_agg(item ORDER BY approved_at DESC), '[]'::jsonb) INTO v_ad_plans
  FROM (
    SELECT ap.approved_at,
      jsonb_build_object(
        'id', ap.id,
        'code', ap.code,
        'version', ap.version,
        'status', ap.status,
        'summary', ap.summary,
        'currency', ap.currency,
        'approvedAt', ap.approved_at,
        -- Explicit client-safe projection: never dump body/forecasts JSON as-is
        -- (extra keys such as an internal note must not reach the portal).
        'body', jsonb_build_object(
          'brief', ap.body::jsonb->>'brief',
          'businessCategory', ap.body::jsonb->>'businessCategory',
          'objective', ap.body::jsonb->>'objective',
          'audience', coalesce(ap.body::jsonb->'audience', '{}'::jsonb),
          'platforms', coalesce(ap.body::jsonb->'platforms', '[]'::jsonb),
          'durationDays', ap.body::jsonb->'durationDays',
          'dailyBudgetMinor', ap.body::jsonb->'dailyBudgetMinor',
          'totalBudgetMinor', ap.body::jsonb->'totalBudgetMinor',
          'currency', 'USD',
          'adIdeas', coalesce(ap.body::jsonb->'adIdeas', '[]'::jsonb),
          'adCopy', coalesce(ap.body::jsonb->'adCopy', '[]'::jsonb),
          'kpis', coalesce(ap.body::jsonb->'kpis', '[]'::jsonb),
          'analysis', coalesce(ap.body::jsonb->'analysis', '{}'::jsonb),
          'disclaimerAr', ap.body::jsonb->>'disclaimerAr',
          'disclaimerEn', ap.body::jsonb->>'disclaimerEn'
        ),
        'forecasts', CASE
          WHEN ap.forecasts IS NULL OR ap.forecasts = '' THEN NULL
          ELSE jsonb_build_object(
            'isEstimate', true,
            'disclaimerAr', ap.forecasts::jsonb->>'disclaimerAr',
            'disclaimerEn', ap.forecasts::jsonb->>'disclaimerEn',
            'totals', coalesce(ap.forecasts::jsonb->'totals', '{}'::jsonb)
          )
        END,
        'disclaimerAr', ap.body::jsonb->>'disclaimerAr',
        'disclaimerEn', ap.body::jsonb->>'disclaimerEn',
        'actuals', jsonb_build_object(
          'spendMinor', coalesce((SELECT sum(r.spend_minor) FROM public.ad_plan_results AS r WHERE r.ad_plan_id = ap.id), 0),
          'impressions', coalesce((SELECT sum(r.impressions) FROM public.ad_plan_results AS r WHERE r.ad_plan_id = ap.id), 0),
          'clicks', coalesce((SELECT sum(r.clicks) FROM public.ad_plan_results AS r WHERE r.ad_plan_id = ap.id), 0),
          'messages', coalesce((SELECT sum(r.messages) FROM public.ad_plan_results AS r WHERE r.ad_plan_id = ap.id), 0),
          'orders', coalesce((SELECT sum(r.orders) FROM public.ad_plan_results AS r WHERE r.ad_plan_id = ap.id), 0)
        ),
        'reports', '[]'::jsonb
      ) AS item
    FROM public.ad_plans AS ap
    WHERE ap.customer_id = v_customer_id
      AND ap.status = 'APPROVED'
      AND ap.version = (
        SELECT MAX(ap2.version) FROM public.ad_plans AS ap2
        WHERE ap2.family_key = ap.family_key AND ap2.status = 'APPROVED'
      )
    ORDER BY ap.approved_at DESC
    LIMIT 20
  ) AS ad_plan_rows;

  RETURN jsonb_build_object(
    'customer', v_customer, 'projects', v_projects, 'offers', v_offers,
    'invoices', v_invoices, 'payments', v_payments, 'subscriptions', v_subscriptions,
    'campaigns', v_campaigns, 'reports', v_reports, 'files', v_files,
    'adPlans', v_ad_plans
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.ofoq_client_dashboard() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ofoq_client_dashboard() TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
