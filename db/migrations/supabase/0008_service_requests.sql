-- =============================================================================
-- Ofoq guided service requests
-- -----------------------------------------------------------------------------
-- The assistant's guided request (type → size → budget → target area →
-- contact channel) ends in /api/chat/service-request, which calls the single
-- RPC defined here. In ONE transaction it:
--
--   1. resolves the signed-in client (creating the missing `customers` row
--      through ofoq_ensure_customer_profile(), exactly like the chat does);
--   2. issues the order reference  OFOQ-<year>-<sequence>  (001, 002, …);
--   3. inserts the `offers` row — status DRAFT (see the note below);
--   4. inserts the /admin/alerts entry: severity IMPORTANT, category
--      NEW_REQUEST, title «طلب خدمة جديد #<order>», the whole request in the
--      body (channel, the WhatsApp number as typed and the wa.me link when
--      WhatsApp was chosen) and the structured details in `meta`;
--   5. notifies every active OWNER/PARTNER (IN_APP sent, EMAIL queued) and
--      writes the activity row.
--
-- It is deliberately NOT ofoq_client_escalate(): that function is the human
-- handoff (HUMAN_REQUEST / URGENT) and refuses any other category. A new
-- request is not a handoff — it must never be raised through that path.
--
-- Idempotent per request: the browser sends a `requestId`; a retry with the
-- same id returns the rows already written instead of a second order.
--
-- Status note (the Supabase «PR #2»): the `offers.status` CHECK of the
-- generated schema allows DRAFT / SENT / APPROVED / REJECTED / EXPIRED /
-- CANCELLED only. REQUESTED is the intended status for these rows, but an
-- insert with it fails the CHECK, so this function writes DRAFT and tags the
-- row (`pricing_breakdown.source = guided_service_request`). The CHECK is
-- widened by db/migrations/supabase/pending/0009_offers_requested_status.sql,
-- which is applied separately; `SERVICE_REQUEST_OFFER_STATUS` in
-- src/lib/services/service-requests.service.ts is the one constant to flip.
--
-- Apply after 0001_auth_portal.sql and 0004_escalation_owner_support.sql.
-- Re-runnable by design: CREATE OR REPLACE only.
-- =============================================================================

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

-- PostgREST caches the schema: without this the site answers PGRST202
-- («Could not find the function … in the schema cache») although the SQL
-- Editor sees the function.
NOTIFY pgrst, 'reload schema';
