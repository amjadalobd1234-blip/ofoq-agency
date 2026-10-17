-- =============================================================================
-- Ofoq · Supabase — harden service-request pricing and offer access (0010)
-- =============================================================================
-- خطوات التطبيق
-- --------------
-- 1) افتح Supabase Dashboard → مشروع الموقع → SQL Editor.
-- 2) شغّله بمالك دالة RPC الحالية (عادة postgres في Supabase SQL Editor)، وبعد
--    وجود مخطط الأساس و0001_auth_portal و0008_service_requests. الـ preflight
--    أدناه يفشل بأمان عند غياب أي جدول/عمود/دالة متوقعة؛
--    لا تتجاوز الخطأ ولا تخمّن اختلاف المخطط.
-- 3) انسخ الملف كاملًا وشغّله مرة واحدة. لا تشغّل pending/0009_offers_requested_status.sql.
-- 4) تحقّق من إشعارات «ofoq: ✓» في النهاية. إذا ظهر «ofoq: ✗»، أوقف النشر وافحص
--    المخطط والصلاحيات قبل إعادة المحاولة.
-- 5) طبّق هذا الترحيل قبل نشر إصدار التطبيق الذي يرسل مدخلات التسعير فقط.
--
-- هذا الملف نسخة يدوية مطابقة للترحيل في
-- db/migrations/supabase/0010_harden_service_requests_and_offer_access.sql.
-- وهو Migration جديد: لا يعيد كتابة أي Migration تاريخي ولا يتصل بقاعدة الإنتاج
-- تلقائيًا. الطلبات تبقى DRAFT؛ لا يُفعّل REQUESTED؛ لا تُحذف أو تُعدّل عروض سابقة.
-- السعر يحسب داخل PostgreSQL، وتُحفظ الخدمة غير المسعّرة بـ NULL، وتُسحب القراءة
-- المباشرة من offers وoffer_items. كما تُستبدل ofoq_client_dashboard بقائمة حالات
-- مسموحة (SENT/APPROVED/REJECTED) فلا تظهر مسودات DRAFT للعميل.
-- الطلبات التاريخية غير الموثقة تحتاج مراجعة مالك
-- المشروع منفصلة؛ لا توجد إعادة حساب تلقائية لبيانات قاعدة غير مفحوصة.
-- =============================================================================

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

-- -----------------------------------------------------------------------------
-- تحقق نهائي غير تعديلي
-- -----------------------------------------------------------------------------
DO $ofoq_verify$
DECLARE
  v_rpc boolean := has_function_privilege(
    'authenticated',
    'public.ofoq_client_service_request(text, text, text, text, text, jsonb, jsonb, jsonb, text, text)',
    'EXECUTE'
  );
  v_helper boolean := has_function_privilege('authenticated', 'public.ofoq_ensure_customer_profile()', 'EXECUTE');
  v_table_private boolean := NOT has_table_privilege('authenticated', 'public.offers', 'SELECT')
    AND NOT has_table_privilege('authenticated', 'public.offer_items', 'SELECT')
    AND NOT has_table_privilege('authenticated', 'public.ofoq_service_request_price_verifications', 'SELECT')
    AND NOT has_table_privilege('anon', 'public.offers', 'SELECT')
    AND NOT has_table_privilege('anon', 'public.offer_items', 'SELECT')
    AND NOT has_table_privilege('anon', 'public.ofoq_service_request_price_verifications', 'SELECT')
    AND NOT has_column_privilege('authenticated', 'public.offers', 'internal_cost_minor', 'SELECT')
    AND NOT has_column_privilege('anon', 'public.offers', 'internal_cost_minor', 'SELECT')
    AND NOT has_column_privilege('authenticated', 'public.offer_items', 'description_ar', 'SELECT')
    AND NOT has_column_privilege('anon', 'public.offer_items', 'description_ar', 'SELECT');
  v_nullable boolean;
BEGIN
  SELECT bool_and(is_nullable = 'YES') INTO v_nullable
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'offers'
    AND column_name IN ('subtotal_minor', 'total_minor');

  IF v_rpc AND v_helper AND v_table_private AND coalesce(v_nullable, false) THEN
    RAISE NOTICE 'ofoq: ✓ hardened request RPC, private offer tables, and nullable unpriced amounts';
  ELSE
    RAISE NOTICE 'ofoq: ✗ verify RPC execute privilege, helper privilege, offer table grants, and nullable amounts';
  END IF;
END
$ofoq_verify$;
