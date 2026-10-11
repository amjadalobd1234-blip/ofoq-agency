-- =============================================================================
-- Ofoq — a 4-argument overload of public.ofoq_client_escalate (manual tests)
-- -----------------------------------------------------------------------------
-- Symptom this file fixes
-- -----------------------
--     ERROR: 42883: function public.ofoq_client_escalate(text, text, text, text) does not exist
--
-- Root cause
-- ----------
-- 42883 is Postgres' answer to «no function matches this NAME together with
-- this ARGUMENT LIST». It does not mean «nothing is installed». What 0003
-- installs and 0004 rewrites is the NINE-argument form:
--
--     ofoq_client_escalate(p_conversation_id, p_category, p_severity,
--                          p_title_ar, p_title_en, p_body_ar, p_body_en,
--                          p_reason, p_signals)
--
-- and that is the contract the application implements. The only call site is
-- `src/lib/services/escalation.service.ts` → `raiseClientEscalation()` →
-- `client.rpc("ofoq_client_escalate", { …nine p_* keys… })`.
-- `src/lib/agents/escalation-agent.ts` never touches Supabase: it is a pure
-- module that decides *whether* to escalate and builds the payload. So a
-- four-argument call from the SQL Editor finds no candidate function, while the
-- app's nine-argument call is unaffected by anything in this file.
--
-- What changes here
-- -----------------
--   1. public.ofoq_client_escalate(text, text, text, text) is added as a thin
--      overload with the signature the manual test (and the Arabic runbook
--      snippets) already use. It does not write anything itself: it maps its
--      four arguments onto the nine and delegates to the canonical function.
--      Dedupe, the `PENDING` conversation, the IN_APP/EMAIL notifications, the
--      `activities` row and the bilingual result therefore stay in ONE
--      implementation. A second, self-contained copy of the alert-writing logic
--      is how an escalation starts answering `ok` while quietly stopping to
--      notify the owner — so it is deliberately not written here.
--   2. No table privileges are granted or revoked. In particular this file does
--      NOT depend on the `GRANT INSERT, SELECT, UPDATE ON public.alerts TO
--      authenticated` that was applied to the live project as «0005»: the
--      function is SECURITY DEFINER and runs as the table owner, so it writes
--      `alerts` with or without that grant. The direct table path stays the
--      diagnostics probe it was designed to be (see `describeAlertInsertError`).
--   3. A guard reports which escalation objects this project actually has, and
--      says out loud when the canonical nine-argument function is missing
--      instead of letting the caller guess.
--   4. A copy-pasteable smoke test at the bottom, including the one thing the
--      SQL Editor does not have: a session user. `auth.uid()` is NULL there, so
--      BOTH overloads raise 28000 «Authentication required or account
--      inactive» — that error is the test working, not a new failure.
--
-- Apply after db/migrations/supabase/0004_escalation_owner_support.sql.
-- Re-runnable by design (CREATE OR REPLACE + guarded DO blocks).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Does this project have the nine-argument function the app calls?
-- -----------------------------------------------------------------------------
-- A named predicate on pg_proc rather than `to_regprocedure('…(text, text, …)')`,
-- because the type list of that cast is picky about whitespace — and a wrong
-- answer here is a migration that silently skips the grants.
--
-- It is deliberately NOT executable by anon/authenticated: it reports schema
-- state, and `ofoq_escalation_diagnostics()` is the RPC already designed to
-- answer that. The two SECURITY DEFINER callers run as the owner, which needs
-- no grant.
CREATE OR REPLACE FUNCTION public.ofoq_has_canonical_escalate()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS p
    JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'ofoq_client_escalate'
      AND p.pronargs = 9
      AND p.proargnames @> ARRAY[
        'p_conversation_id', 'p_category', 'p_severity',
        'p_title_ar', 'p_title_en', 'p_body_ar', 'p_body_en',
        'p_reason', 'p_signals'
      ]::text[]
  );
$function$;

REVOKE ALL ON FUNCTION public.ofoq_has_canonical_escalate() FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 2. The 4-argument overload: same escalation, fewer keys to type
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ofoq_client_escalate(
  p_conversation_id text,
  p_reason text DEFAULT 'HUMAN_REQUEST',
  p_summary text DEFAULT NULL,
  p_severity text DEFAULT 'IMPORTANT'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_identity text := coalesce(nullif(trim(p_reason), ''), 'HUMAN_REQUEST');
  v_category text;
  v_severity text;
  v_reason text;
  v_signals text := 'manual_sql_editor';
  v_summary text := nullif(trim(coalesce(p_summary, '')), '');
  v_title_ar text := 'عميل جديد يطلب تواصل';
  v_title_en text := 'New client requesting contact';
  v_label_ar text;
  v_label_en text;
  v_body_ar text;
  v_body_en text;
  v_conversation_id text := nullif(trim(coalesce(p_conversation_id, '')), '');
  v_result jsonb;
  v_now text := to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  -- The canonical function is the only writer of alerts. Say so, precisely,
  -- rather than failing inside the delegation with a second 42883.
  IF NOT public.ofoq_has_canonical_escalate() THEN
    RAISE EXCEPTION
      'The nine-argument public.ofoq_client_escalate is not installed; apply db/migrations/supabase/0004_escalation_owner_support.sql (or the whole docs/setup/supabase-setup.sql bundle) before using this overload'
      USING ERRCODE = '42883', HINT = 'SELECT pg_get_function_arguments(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = ''public'' AND p.proname = ''ofoq_client_escalate'';';
  END IF;

  IF v_conversation_id IS NULL THEN
    RAISE EXCEPTION 'p_conversation_id is required' USING ERRCODE = '22023';
  END IF;

  -- `p_reason` is the category in this overload. An unknown word here is kept
  -- for the audit trail instead of being rejected: a manual test should not
  -- fail on vocabulary, and `alerts.meta` records what was actually passed.
  v_category := upper(v_identity);
  IF v_category NOT IN ('HUMAN_REQUEST', 'NEW_LEAD') THEN
    v_reason := left(v_identity, 500);
    v_category := 'HUMAN_REQUEST';
  ELSE
    v_reason := 'manual ofoq_client_escalate(4-arg) call from the Supabase SQL Editor';
  END IF;

  -- Same allow-list as the canonical function, checked here so the message
  -- names THIS argument instead of surfacing as an alerts CHECK violation.
  v_severity := upper(coalesce(nullif(trim(p_severity), ''), 'IMPORTANT'));
  IF v_severity NOT IN ('URGENT', 'IMPORTANT') THEN
    RAISE EXCEPTION 'Unknown escalation severity "%" — expected URGENT or IMPORTANT', v_severity
      USING ERRCODE = '22023';
  END IF;

  -- Labels and titles match ESCALATION_CATEGORY_LABELS / ESCALATION_TITLES in
  -- src/lib/agents/escalation-agent.ts, so a hand-raised alert is
  -- indistinguishable from one the assistant raised.
  IF v_category = 'HUMAN_REQUEST' THEN
    v_label_ar := 'طلب فريق بشري';
    v_label_en := 'Human handoff';
  ELSE
    v_label_ar := 'طلب جديد';
    v_label_en := 'New lead';
  END IF;

  -- Body shape mirrors summariseConversation(): [label] reason, blank line,
  -- then the summary. 1400 chars is that module's MAX_BODY_LENGTH.
  v_body_ar := left(
    '[' || v_label_ar || '] ' ||
      CASE WHEN v_category = 'HUMAN_REQUEST'
        THEN 'العميل طلب التواصل مع فريق بشري'
        ELSE 'اكتمل فهم احتياج العميل'
      END ||
      chr(10) || chr(10) || coalesce(v_summary, 'طلب العميل التواصل مع فريق بشري.'),
    1400
  );
  v_body_en := left(
    '[' || v_label_en || '] ' ||
      CASE WHEN v_category = 'HUMAN_REQUEST'
        THEN 'The client asked to speak with a human team member'
        ELSE 'The client brief is understood'
      END ||
      chr(10) || chr(10) || coalesce(v_summary, 'Client requested human support.'),
    1400
  );

  -- Delegation is POSITIONAL on purpose: nine arguments can only match the
  -- canonical function, so this overload can never resolve to itself.
  v_result := public.ofoq_client_escalate(
    v_conversation_id, -- p_conversation_id
    v_category,        -- p_category
    v_severity,        -- p_severity
    v_title_ar,        -- p_title_ar
    v_title_en,        -- p_title_en
    v_body_ar,         -- p_body_ar
    v_body_en,         -- p_body_en
    v_reason,          -- p_reason
    v_signals          -- p_signals
  );

  -- Everything the service contract needs (alertId, created, staff,
  -- clientName, clientEmail, conversationStatus, identity) comes from the
  -- canonical result untouched; the keys below are the ones a manual reader
  -- asks for.
  RETURN coalesce(v_result, '{}'::jsonb) || jsonb_build_object(
    'ok', v_result IS NOT NULL,
    'alertId', v_result ->> 'alertId',
    'conversationId', v_conversation_id,
    'customerId', v_result -> 'identity' ->> 'customerId',
    'timestamp', v_now,
    'via', '4-arg overload → ofoq_client_escalate(p_conversation_id, p_category, p_severity, p_title_ar, p_title_en, p_body_ar, p_body_en, p_reason, p_signals)'
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.ofoq_client_escalate(text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ofoq_client_escalate(text, text, text, text) TO authenticated;

-- -----------------------------------------------------------------------------
-- 3. Re-assert the canonical grant, and report the state of the project
-- -----------------------------------------------------------------------------
-- Guarded so this file can be applied to a project that never received 0004
-- without aborting the whole transaction: `REVOKE … (text × 9)` would itself
-- fail with 42883 there, which is the exact error this migration is about.
DO $grants$
BEGIN
  IF public.ofoq_has_canonical_escalate() THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.ofoq_client_escalate(text, text, text, text, text, text, text, text, text) FROM PUBLIC, anon';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.ofoq_client_escalate(text, text, text, text, text, text, text, text, text) TO authenticated';
    RAISE NOTICE 'ofoq: ofoq_client_escalate is callable with 4 arguments (manual tests) and with 9 (the application)';
  ELSE
    RAISE WARNING
      'ofoq: the nine-argument public.ofoq_client_escalate is MISSING. The 4-argument overload was installed but will report 42883 until 0004 is applied — so the application''s own escalation is still broken on this project.';
  END IF;
END
$grants$;

-- One glance is enough to know what a project has. Run the same SELECT outside
-- a migration to re-check at any time.
DO $report$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_arguments(p.oid) || ')' AS signature
    FROM pg_proc AS p
    JOIN pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'ofoq_client_escalate',
        'ofoq_escalation_email_result',
        'ofoq_escalation_diagnostics',
        'ofoq_ensure_customer_profile'
      )
    ORDER BY p.proname, pg_get_function_arguments(p.oid)
  LOOP
    RAISE NOTICE 'ofoq: %', r.signature;
  END LOOP;
END
$report$;

-- -----------------------------------------------------------------------------
-- 4. Smoke test — read the note about auth.uid() before running it
-- -----------------------------------------------------------------------------
-- Both overloads resolve the caller with `(SELECT auth.uid())::text` and raise
-- 28000 when there is no session. The SQL Editor has no JWT, so a bare
--
--     SELECT public.ofoq_client_escalate('<conversation>', 'HUMAN_REQUEST', 'test', 'URGENT');
--
-- answers «Authentication required or account inactive». That is the function
-- working as designed, not a missing grant. To test by hand, give the session a
-- user first and roll the write back:
--
--   BEGIN;
--     SET LOCAL request.jwt.claims = '{"sub":"<users.id of an ACTIVE account>","role":"authenticated"}';
--
--     -- who is this account, and can it escalate?
--     SELECT public.ofoq_escalation_diagnostics();
--
--     -- the 4-argument overload added by this file
--     SELECT public.ofoq_client_escalate(
--       '<conversation.id, channel WEB>',
--       'HUMAN_REQUEST',
--       'اختبار يدوي من SQL Editor',
--       'URGENT'
--     );
--   ROLLBACK;
--
-- `SET LOCAL` only survives inside an open transaction. If the editor is set to
-- run each statement separately, use `SET request.jwt.claims = …` instead and
-- `RESET request.jwt.claims;` when finished — otherwise the GUC is dropped
-- before the SELECT runs and the call answers 28000 again.
--
-- `<users.id>` may be an OWNER: since 0004 any active OWNER/PARTNER may escalate
-- any WEB conversation. To find both ids in one go:
--
--   SELECT c.id AS conversation_id, c.customer_id, cu.user_id, u.email, u.role, u.status
--   FROM public.conversations AS c
--   LEFT JOIN public.customers AS cu ON cu.id = c.customer_id
--   LEFT JOIN public.users AS u ON u.id = cu.user_id
--   WHERE c.channel = 'WEB'
--   ORDER BY c.updated_at DESC
--   LIMIT 5;
--
-- An end-to-end check without SQL at all: sign in, tell the assistant
-- «أريد التحدث مع شخص حقيقي», and expect «✔ تم تحويل محادثتك…» plus a row in
-- /admin → أحدث الطلبات. `created: false` in the RPC result means an alert for
-- this conversation and category already exists today — that is the dedupe, and
-- it is the reason the smoke test above must run inside a rolled-back
-- transaction if you want the daily limit to stay untouched.
