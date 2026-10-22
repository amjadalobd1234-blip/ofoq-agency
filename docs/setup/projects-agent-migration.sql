-- =============================================================================
-- Ofoq · Supabase — خطط المشاريع في بوابة العميل (0011)
-- =============================================================================
-- خطوات التطبيق
-- --------------
-- 1) افتح Supabase Dashboard → مشروع الموقع → SQL Editor.
-- 2) شغّله بمالك دالة RPC الحالية (عادة postgres في Supabase SQL Editor)، وبعد
--    وجود مخطط الأساس و0001_auth_portal و0010_harden_service_requests_and_offer_access.sql.
--    الـ preflight أدناه يفشل بأمان عند غياب أي جدول/عمود/دالة متوقعة؛
--    لا تتجاوز الخطأ ولا تخمّن اختلاف المخطط.
-- 3) انسخ الملف كاملًا وشغّله مرة واحدة. الملف idempotent: ينشئ جدول
--    project_plans وأعمدة project_tasks إن لم تكن موجودة، ولا يحذف أو يعدّل
--    أي بيانات تاريخية.
-- 4) تحقّق من إشعارات «ofoq: ✓» في النهاية. إذا ظهر «ofoq: ✗»، أوقف النشر وافحص
--    المخطط والصلاحيات قبل إعادة المحاولة.
-- 5) طبّق هذا الترحيل قبل نشر إصدار التطبيق الذي يعرض خطة المشروع للعميل.
--
-- هذا الملف نسخة يدوية مطابقة للترحيل في
-- db/migrations/supabase/0011_project_plans.sql.
-- وهو Migration جديد: لا يعيد كتابة أي Migration تاريخي ولا يتصل بقاعدة الإنتاج
-- تلقائيًا. ما الذي يضيفه:
--   * جدول project_plans + عمودَي internal_note وphase_key في project_tasks
--     (ينشئهما هذا الملف عند الحاجة)؛
--   * RLS على project_plans وسحب القراءة المباشرة: الخطة تُقدَّم عبر RPC
--     يتحقق من ملكية العميل؛
--   * ofoq_client_dashboard تُعيد الآن المشروع مع الخطة APPROVED فقط
--     وبالمهام الظاهرة للعميل (visibility = CLIENT)؛
--     والمهمة المرتبطة بمرحلة موجودة في مسودة أحدث فقط لا تُعدّ التزامًا
--     ولا تُعاد للعميل حتى تُعتمد المرحلة.
--   * ofoq_client_project_detail(text) لعرض مشروع واحد للعميل نفسه.
-- لا تُعطَّل داخليات المشروع ولا التكاليف ولا الملاحظات الداخلية للعميل.
-- =============================================================================

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
--     Internal tasks, internal notes and unapproved plans are never returned,
--     and a plan task is committed only when its phase belongs to an APPROVED
--     plan — a phase that exists merely in a newer draft stays invisible.
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
            -- A plan task is committed only when its phase belongs to a plan
            -- the owner has APPROVED. A task of a phase that exists merely in
            -- a newer draft is still a proposal: it never reaches the client.
            AND (
              t.phase_key IS NULL
              OR t.phase_key IN (
                SELECT approved_phase.value->>'key'
                FROM public.project_plans AS approved_plan
                CROSS JOIN LATERAL jsonb_array_elements(approved_plan.phases::jsonb) AS approved_phase(value)
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
    -- Same rule as the dashboard: only a phase of an APPROVED plan commits.
    AND (
      t.phase_key IS NULL
      OR t.phase_key IN (
        SELECT approved_phase.value->>'key'
        FROM public.project_plans AS approved_plan
        CROSS JOIN LATERAL jsonb_array_elements(approved_plan.phases::jsonb) AS approved_phase(value)
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
    -- The progress counts the same committed tasks the client is shown.
    AND (
      t.phase_key IS NULL
      OR t.phase_key IN (
        SELECT approved_phase.value->>'key'
        FROM public.project_plans AS approved_plan
        CROSS JOIN LATERAL jsonb_array_elements(approved_plan.phases::jsonb) AS approved_phase(value)
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
