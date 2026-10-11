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
