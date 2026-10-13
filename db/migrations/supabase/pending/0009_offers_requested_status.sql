-- =============================================================================
-- Ofoq offers: REQUESTED status  (Supabase «PR #2» — NOT bundled yet)
-- -----------------------------------------------------------------------------
-- The guided service request saves its `offers` row as DRAFT because the
-- `offers.status` CHECK of the generated schema allows only
-- DRAFT / SENT / APPROVED / REJECTED / EXPIRED / CANCELLED.
--
-- This migration widens the CHECK to accept REQUESTED — the status a client's
-- own request should carry until the team turns it into a real offer — and
-- promotes the rows already written by the guided request.
--
-- It lives under db/migrations/supabase/pending/ on purpose: the generator
-- (`npm run db:generate-postgres`) bundles only the top-level files into
-- docs/setup/supabase-setup.sql, so applying the setup file today does NOT
-- run this. Steps for the Supabase PR #2:
--
--   1. move this file to db/migrations/supabase/0009_offers_requested_status.sql,
--   2. add REQUESTED to the SQLite CHECK as a new sqlite migration (SQLite
--      cannot alter a CHECK in place: copy table → drop → rename), then run
--      `npm run db:generate-postgres`,
--   3. flip SERVICE_REQUEST_OFFER_STATUS to "REQUESTED" in
--      src/lib/services/service-requests.service.ts, let
--      ofoq_client_service_request() accept it (the status guard), update the
--      tests that assert DRAFT, and extend `OfferStatus` in src/lib/domain/types.ts.
--
-- Re-runnable: the constraint is dropped and recreated by name.
-- =============================================================================

ALTER TABLE public.offers DROP CONSTRAINT IF EXISTS offers_status_check;
ALTER TABLE public.offers
  ADD CONSTRAINT offers_status_check
  CHECK (status IN ('DRAFT', 'REQUESTED', 'SENT', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED'));

-- Rows written by the guided request while DRAFT was the only option.
UPDATE public.offers
SET status = 'REQUESTED',
    updated_at = to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
WHERE status = 'DRAFT'
  AND created_by_agent = 'pricing-agent'
  AND pricing_breakdown LIKE '%"source":"guided_service_request"%';

NOTIFY pgrst, 'reload schema';
