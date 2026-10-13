-- =============================================================================
-- Ofoq · Supabase — تطبيق يدوي لحفظ طلبات الخدمة الموجّهة
-- =============================================================================
--
-- لماذا هذا الملف؟
-- ----------------
-- رسالة الموقع «تعذر حفظ طلبك ❌ — قاعدة البيانات ما زالت بلا حالة حفظ الطلبات
-- (service_requests.sql — 0008)» تعني أن الدالة
-- public.ofoq_client_service_request غير مثبّتة في مشروع Supabase الذي يعمل
-- عليه الموقع. هذا الملف يثبّتها، مع سياسات RLS، وتقرير تحقّق في النهاية.
-- الملف **آمن لإعادة التشغيل** (CREATE OR REPLACE + إعدادات متكرّرة بلا أثر).
--
-- خطوات التطبيق (انسخ والصق)
-- --------------------------
-- 1) افتح Supabase Dashboard → اختر مشروع الموقع → SQL Editor → New query.
-- 2) شغّل أولًا قسم «0) فحص المتطلبات» من هذا الملف (تحديد القسم ثم Run يكفي)
--    وتأكد أن كل الصفوف فيها installed = true. إن كان أي صف false فطبّق أولًا
--    الملف docs/setup/supabase-setup.sql كاملًا (هو يحتوي 0001_auth_portal.sql
--    ومعه ofoq_ensure_customer_profile والأعمدة التي يكتبها هذا الملف).
-- 3) الصق **كامل** هذا الملف في SQL Editor واضغط Run مرة واحدة.
-- 4) اقرأ النتيجة في تبويب النتائج/الرسائل (Output / Notices):
--      ofoq: ✓ public.ofoq_client_service_request(...) — executable by authenticated: true
--    أي تحذير يبدأ بـ «ofoq: ✗» يسمّي بالضبط ما ينقص.
-- 5) لا تحتاج أي خطوة إضافية: نهاية الملف هي
--      NOTIFY pgrst, 'reload schema';
--    حتى يعيد PostgREST وصف المخطط فورًا (بدونها قد يبقى الرد PGRST202).
-- 6) من الموقع: ارجع للدردشة واضغط «إعادة المحاولة» — نفس requestId يُرسل مرة
--    أخرى فلا يتكرر الطلب، وتظهر «رقم الطلب: OFOQ-<سنة>-NNN».
--
-- ما يثبّته هذا الملف
-- -------------------
--   1. public.ofoq_client_service_request(): يحفظ الطلب في معاملة واحدة —
--      صفّ public.offers (حالة DRAFT) + تنبيه NEW_REQUEST / IMPORTANT في
--      public.alerts (بعنوان «طلب خدمة جديد #OFOQ-…») + إشعارات الفريق +
--      سجل النشاط، ويعيد رقم الطلب OFOQ-<سنة>-NNN (idempotent لكل requestId).
--   2. تفعيل RLS على الجداول التي تلمسها الدالة (دفاع في العمق).
--   3. صلاحيات التنفيذ: anon ممنوع، authenticated مسموح.
--   4. تقرير تحقّق + إعادة تحميل مخطط PostgREST.
--
-- ملاحظات مهمة
-- ------------
-- * لا يحتاج المشروع إلى جدول جديد: الطلب يُحفظ في public.offers القائم
--   (status = DRAFT حتى تجهز الترقية، انظر db/migrations/supabase/pending/
--   0009_offers_requested_status.sql) والتنبيه في public.alerts.
-- * لا توجد سياسات RLS جديدة إلزامية لهذا المسار: الدالة SECURITY DEFINER
--   وتعمل بصلاحيات المالك، والعميل لا يقرأ هذه الجداول مباشرة. القسم «1» يعيد
--   تأكيد تفعيل RLS فقط، وهذا كل ما يطلبه المسار.
-- * محتوى الدالة هنا **مطابق حرفيًا** لملف
--   db/migrations/supabase/0008_service_requests.sql (ونسخته داخل
--   docs/setup/supabase-setup.sql). إذا كانت بقية المخطط مثبّتة عندك، هذا
--   الملف وحده يكفي.
-- * المصدر الوحيد للحقيقة: db/migrations/supabase/0008_service_requests.sql.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 0) فحص المتطلبات — شغّله أولًا، يجب أن تكون كل القيم true
-- -----------------------------------------------------------------------------
SELECT
  'ofoq_ensure_customer_profile()' AS requirement,
  EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS p
    JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'ofoq_ensure_customer_profile'
  ) AS installed
UNION ALL
SELECT
  'tables: offers, alerts, notifications, activities, conversations, customers',
  COUNT(DISTINCT c.relname) = 6
  FROM pg_catalog.pg_class AS c
  JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r'
    AND c.relname IN ('offers', 'alerts', 'notifications', 'activities', 'conversations', 'customers')
UNION ALL
SELECT
  'alerts columns: dedupe_key, meta, target_role, customer_id',
  COUNT(*) = 4
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'alerts'
    AND column_name IN ('dedupe_key', 'meta', 'target_role', 'customer_id');


-- -----------------------------------------------------------------------------
-- 1) RLS — الجداول التي تلمسها الدالة تبقى محميّة أمام Data API
-- -----------------------------------------------------------------------------
-- سياسات جديدة غير مطلوبة لهذا المسار (الدالة SECURITY DEFINER)، لكن سياسة
-- «الوصول عبر الدوال فقط» هي ما يفرضه docs/setup/supabase-setup.sql، فنعيد
-- تأكيدها هنا حتى لا يعتمد المسار على ترتيب التطبيق.
ALTER TABLE public.offers        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alerts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activities    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customers     ENABLE ROW LEVEL SECURITY;


-- -----------------------------------------------------------------------------
-- 2) الدالة — حفظ الطلب كاملًا في معاملة واحدة (منقولة حرفيًا من 0008)
-- -----------------------------------------------------------------------------
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

-- ↑ هذان السطران (REVOKE عن anon / GRANT إلى authenticated) هما الصلاحيات
--   المطلوبة لهذا المسار؛ لا حاجة لتعديلها.

-- -----------------------------------------------------------------------------
-- 3) إعادة تحميل مخطط PostgREST + تقرير تحقّق يظهر في تبويب النتائج
-- -----------------------------------------------------------------------------
-- لماذا NOTIFY؟ لأن PostgREST يخزّن وصف المخطط: قد توجد الدالة ويستطيع SQL
-- Editor استدعاءها، ومع ذلك يردّ Data API بـ PGRST202 («Could not find the
-- function … in the schema cache») حتى يُطلب تحميل المخطط من جديد.
NOTIFY pgrst, 'reload schema';

DO $ofoq_service_request_verify$
DECLARE
  r record;
  v_missing text[] := ARRAY[]::text[];
BEGIN
  -- (أ) الدالة نفسها، بأسماء معاملاتها وبصلاحية authenticated.
  SELECT p.oid::regprocedure::text AS signature,
         coalesce(p.proargnames, ARRAY[]::text[]) AS arg_names,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') AS executable
    INTO r
  FROM pg_catalog.pg_proc AS p
  JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname::text = 'ofoq_client_service_request'
  LIMIT 1;

  IF r IS NULL THEN
    v_missing := v_missing || 'public.ofoq_client_service_request (the RPC itself)';
    RAISE WARNING 'ofoq: ✗ public.ofoq_client_service_request is NOT installed — the guided request cannot be saved.';
  ELSE
    RAISE NOTICE 'ofoq: ✓ % — executable by authenticated: %', r.signature, r.executable;
    IF NOT (r.arg_names @> ARRAY['p_request_id', 'p_offer', 'p_contact']::text[]) THEN
      v_missing := v_missing || ('unexpected argument names: ' || array_to_string(r.arg_names, ', '));
    END IF;
    IF NOT r.executable THEN
      v_missing := v_missing || 'authenticated lacks EXECUTE on public.ofoq_client_service_request';
    END IF;
  END IF;

  -- (ب) ما تحتاجه الدالة داخليًا (تظهر هنا مشكلة مخطط ناقص قبل أن تظهر للعميل).
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc AS p
    JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'ofoq_ensure_customer_profile'
  ) THEN
    v_missing := v_missing || 'public.ofoq_ensure_customer_profile() is missing (apply docs/setup/supabase-setup.sql)';
  END IF;

  IF array_length(v_missing, 1) > 0 THEN
    RAISE WARNING 'ofoq: the request could not be saved until these are fixed: %', array_to_string(v_missing, ' | ');
  ELSE
    RAISE NOTICE 'ofoq: ✓ طلبات الخدمة جاهزة — the guided request can be saved now. The Data API was asked to reload its schema cache.';
  END IF;
END
$ofoq_service_request_verify$;


-- -----------------------------------------------------------------------------
-- 4) فحص «دخان» اختياري (بعد التطبيق): يعرض ما سجّلته الدالة فعليًا
-- -----------------------------------------------------------------------------
-- SELECT status, code, created_at FROM public.offers ORDER BY created_at DESC LIMIT 5;
-- SELECT severity, category, title_ar, created_at FROM public.alerts
--   WHERE category = 'NEW_REQUEST' ORDER BY created_at DESC LIMIT 5;
