-- =============================================================================
-- Ofoq AI usage log (public.ai_usage)
-- -----------------------------------------------------------------------------
-- Stores one row per AI provider attempt (success, rate limit, timeout, error,
-- skipped provider). Written by the API routes through `ofoq_ai_usage_record`
-- and read by the owner-only `ofoq_ai_usage_admin` RPC that backs
-- /admin/settings/integrations.
--
-- Design notes:
--   * Direct table access stays revoked for anon/authenticated; RLS is enabled
--     with no policies. Both access paths are SECURITY DEFINER functions.
--   * No API key, prompt or model answer is ever stored here: only provider,
--     model id, token counts, status and duration.
--   * Re-runnable by design (IF NOT EXISTS / CREATE OR REPLACE).
--
-- Apply after db/migrations/supabase/0001_auth_portal.sql.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.ai_usage (
  id              TEXT PRIMARY KEY,
  provider        TEXT NOT NULL,
  model           TEXT NOT NULL,
  agent_key       TEXT,
  customer_id     TEXT,
  input_tokens    INTEGER DEFAULT 0,
  output_tokens   INTEGER DEFAULT 0,
  status          TEXT NOT NULL,
  duration_ms     INTEGER DEFAULT 0,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_provider ON public.ai_usage (provider, created_at DESC);

-- The integrations screen asks for "the last 10 requests" and "today's usage",
-- which this index serves directly.
CREATE INDEX IF NOT EXISTS idx_ai_usage_created_at ON public.ai_usage (created_at DESC);

ALTER TABLE public.ai_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ai_usage FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Role helper (owner-only surfaces)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ofoq_is_owner()
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
      AND u.role = 'OWNER'
      AND u.status = 'ACTIVE'
  );
$function$;

REVOKE ALL ON FUNCTION public.ofoq_is_owner() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ofoq_is_owner() TO authenticated;

-- -----------------------------------------------------------------------------
-- Write path — one usage row per provider attempt
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ofoq_ai_usage_record(
  p_id            text,
  p_provider      text,
  p_model         text,
  p_agent_key     text DEFAULT NULL,
  p_customer_id   text DEFAULT NULL,
  p_input_tokens  integer DEFAULT 0,
  p_output_tokens integer DEFAULT 0,
  p_status        text DEFAULT 'OK',
  p_duration_ms   integer DEFAULT 0
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_user_id text := (SELECT auth.uid())::text;
  v_is_staff boolean := public.ofoq_is_staff();
  v_customer_id text;
  v_provider text := lower(trim(coalesce(p_provider, '')));
  v_model text := left(trim(coalesce(p_model, '')), 120);
  v_status text := upper(trim(coalesce(p_status, 'OK')));
  v_id text := coalesce(nullif(trim(coalesce(p_id, '')), ''), gen_random_uuid()::text);
  v_now text := to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  IF v_user_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.users AS u WHERE u.id = v_user_id AND u.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'Authentication required or account inactive' USING ERRCODE = '28000';
  END IF;

  IF v_provider = '' OR length(v_provider) > 40 THEN
    RAISE EXCEPTION 'Invalid provider';
  END IF;

  IF v_status NOT IN ('OK', 'RATE_LIMIT', 'TIMEOUT', 'PROVIDER_ERROR', 'MISSING_KEY', 'EMPTY_RESPONSE', 'UNAVAILABLE') THEN
    v_status := 'PROVIDER_ERROR';
  END IF;

  IF v_model = '' THEN
    v_model := 'unknown';
  END IF;

  -- Attribution is never client-chosen: a client row always belongs to the
  -- caller's own customer record; staff may attribute to any customer or none.
  IF v_is_staff THEN
    v_customer_id := nullif(trim(coalesce(p_customer_id, '')), '');
  ELSE
    SELECT c.id INTO v_customer_id
    FROM public.customers AS c
    WHERE c.user_id = v_user_id
    ORDER BY c.created_at ASC
    LIMIT 1;

    -- Cheap abuse guard: a single client account cannot write unlimited rows.
    IF (
      SELECT count(*) FROM public.ai_usage AS a
      WHERE a.customer_id = v_customer_id
        AND a.created_at >= to_char(timezone('utc', now()) - interval '1 minute', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ) >= 60 THEN
      RAISE EXCEPTION 'Too many AI usage records. Please wait a moment.' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  INSERT INTO public.ai_usage
    (id, provider, model, agent_key, customer_id, input_tokens, output_tokens, status, duration_ms, created_at)
  VALUES
    (v_id, v_provider, v_model, nullif(trim(coalesce(p_agent_key, '')), ''), v_customer_id,
     greatest(0, coalesce(p_input_tokens, 0)), greatest(0, coalesce(p_output_tokens, 0)),
     v_status, greatest(0, coalesce(p_duration_ms, 0)), v_now)
  ON CONFLICT (id) DO NOTHING;

  RETURN v_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.ofoq_ai_usage_record(text, text, text, text, text, integer, integer, text, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ofoq_ai_usage_record(text, text, text, text, text, integer, integer, text, integer)
  TO authenticated;

-- -----------------------------------------------------------------------------
-- Read path — owner-only summary for /admin/settings/integrations
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ofoq_ai_usage_admin()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_today jsonb;
  v_recent jsonb;
  v_day_start text := to_char(date_trunc('day', timezone('utc', now())), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  IF NOT public.ofoq_is_owner() THEN
    RAISE EXCEPTION 'Owner access required' USING ERRCODE = '42501';
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'provider', t.provider,
    'requests', t.requests,
    'failures', t.failures,
    'inputTokens', t.input_tokens,
    'outputTokens', t.output_tokens
  ) ORDER BY t.provider), '[]'::jsonb) INTO v_today
  FROM (
    SELECT a.provider,
           count(*)::int AS requests,
           count(*) FILTER (WHERE a.status <> 'OK')::int AS failures,
           coalesce(sum(a.input_tokens), 0)::int AS input_tokens,
           coalesce(sum(a.output_tokens), 0)::int AS output_tokens
    FROM public.ai_usage AS a
    WHERE a.created_at >= v_day_start
    GROUP BY a.provider
  ) AS t;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id, 'provider', r.provider, 'model', r.model,
    'agentKey', r.agent_key, 'customerId', r.customer_id,
    'inputTokens', r.input_tokens, 'outputTokens', r.output_tokens,
    'status', r.status, 'durationMs', r.duration_ms, 'createdAt', r.created_at
  ) ORDER BY r.created_at DESC), '[]'::jsonb) INTO v_recent
  FROM (SELECT * FROM public.ai_usage ORDER BY created_at DESC LIMIT 10) AS r;

  RETURN jsonb_build_object(
    'generatedAt', to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'today', v_today,
    'recent', v_recent
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.ofoq_ai_usage_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ofoq_ai_usage_admin() TO authenticated;
