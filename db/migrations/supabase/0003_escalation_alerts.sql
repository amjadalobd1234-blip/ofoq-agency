-- =============================================================================
-- Ofoq client escalation → real alerts, notifications and owner handoff
-- -----------------------------------------------------------------------------
-- Called by POST /api/chat through src/lib/services/escalation.service.ts when
-- the escalation agent decides a conversation needs a human:
--
--   public.ofoq_client_escalate(...)          one transaction that
--       1. inserts the `alerts` row (severity URGENT|IMPORTANT, category
--          HUMAN_REQUEST|NEW_LEAD, entity_type 'conversation', target_role
--          'ANY_STAFF', status 'NEW'),
--       2. sets conversations.status = 'PENDING',
--       3. writes IN_APP + EMAIL `notifications` for every active OWNER/PARTNER,
--       4. logs the event in `activities`,
--       and returns what the route needs to email the owner truthfully.
--
--   public.ofoq_escalation_email_result(...)  records whether the owner email
--       was actually delivered, so a failed send is visible instead of silent.
--
-- Design notes:
--   * No service-role key. Both functions are SECURITY DEFINER, re-check the
--     caller's JWT and verify the caller owns the conversation.
--   * Deduplicated per conversation, category and UTC day through
--     `alerts.dedupe_key`, so a client asking twice cannot flood /admin. A
--     RESOLVED alert is re-opened instead of being ignored.
--   * Re-runnable by design (CREATE OR REPLACE).
--
-- Apply after db/migrations/supabase/0001_auth_portal.sql.
-- =============================================================================

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
  v_customer_id text;
  v_customer_name text;
  v_customer_email text;
  v_category text := upper(coalesce(trim(p_category), 'HUMAN_REQUEST'));
  v_severity text := upper(coalesce(trim(p_severity), 'IMPORTANT'));
  v_alert_id text;
  v_dedupe_key text;
  v_created boolean := false;
  v_staff jsonb;
  v_now text := to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_day text := to_char(timezone('utc', now()), 'YYYY-MM-DD');
BEGIN
  IF v_user_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.users AS u WHERE u.id = v_user_id AND u.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'Authentication required or account inactive' USING ERRCODE = '28000';
  END IF;

  IF v_category NOT IN ('HUMAN_REQUEST', 'NEW_LEAD') THEN
    RAISE EXCEPTION 'Unknown escalation category' USING ERRCODE = '22023';
  END IF;
  IF v_severity NOT IN ('URGENT', 'IMPORTANT') THEN
    RAISE EXCEPTION 'Unknown escalation severity' USING ERRCODE = '22023';
  END IF;
  IF p_conversation_id IS NULL OR length(trim(p_conversation_id)) = 0 THEN
    RAISE EXCEPTION 'A conversation id is required' USING ERRCODE = '22023';
  END IF;

  -- Ownership: only the client who owns this conversation can escalate it.
  SELECT c.customer_id, cu.contact_name, cu.email
  INTO v_customer_id, v_customer_name, v_customer_email
  FROM public.conversations AS c
  JOIN public.customers AS cu ON cu.id = c.customer_id
  WHERE c.id = p_conversation_id AND cu.user_id = v_user_id AND c.channel = 'WEB';

  IF v_customer_id IS NULL THEN
    RAISE EXCEPTION 'Conversation not found' USING ERRCODE = '42501';
  END IF;

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
         'clientEmail', v_customer_email
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
       'reason', p_reason
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
    'staff', coalesce(v_staff, '[]'::jsonb)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.ofoq_escalation_email_result(
  p_alert_id text,
  p_delivered boolean,
  p_provider text DEFAULT NULL,
  p_error text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_user_id text := (SELECT auth.uid())::text;
  v_now text := to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_updated integer;
BEGIN
  IF v_user_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.users AS u WHERE u.id = v_user_id AND u.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'Authentication required or account inactive' USING ERRCODE = '28000';
  END IF;

  -- Only the client who raised the escalation, or a staff member, may report on it.
  IF NOT public.ofoq_is_staff() AND NOT EXISTS (
    SELECT 1
    FROM public.alerts AS a
    JOIN public.conversations AS c ON c.id = a.entity_id
    JOIN public.customers AS cu ON cu.id = c.customer_id
    WHERE a.id = p_alert_id AND a.entity_type = 'conversation' AND cu.user_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'Not allowed to update this alert' USING ERRCODE = '42501';
  END IF;

  UPDATE public.notifications
  SET status = CASE WHEN coalesce(p_delivered, false) THEN 'SENT' ELSE 'FAILED' END,
      error = CASE WHEN coalesce(p_delivered, false) THEN NULL ELSE left(coalesce(p_error, 'not delivered'), 500) END,
      sent_at = CASE WHEN coalesce(p_delivered, false) THEN v_now ELSE NULL END
  WHERE alert_id = p_alert_id AND channel = 'EMAIL';

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  RETURN jsonb_build_object(
    'alertId', p_alert_id,
    'delivered', coalesce(p_delivered, false),
    'provider', coalesce(nullif(trim(p_provider), ''), 'console'),
    'updated', v_updated,
    'updatedAt', v_now
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.ofoq_client_escalate(text, text, text, text, text, text, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ofoq_escalation_email_result(text, boolean, text, text) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.ofoq_client_escalate(text, text, text, text, text, text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ofoq_escalation_email_result(text, boolean, text, text) TO authenticated;
