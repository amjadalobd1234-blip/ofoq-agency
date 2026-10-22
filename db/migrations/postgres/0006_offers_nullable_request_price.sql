-- GENERATED FILE — do not edit by hand.
-- Source of truth: db/migrations/sqlite/*.sql
-- Regenerate with: npm run db:generate-postgres
-- PostgreSQL equivalent of 0003_offers_nullable_request_price.sql.

ALTER TABLE public.offers ALTER COLUMN subtotal_minor DROP NOT NULL;

ALTER TABLE public.offers ALTER COLUMN total_minor DROP NOT NULL;
