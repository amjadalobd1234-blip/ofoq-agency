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
