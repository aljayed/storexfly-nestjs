-- Order deadlines, cancellation reasons, and exchanges.
--
-- A shop that stops answering used to leave a buyer holding an order forever.
-- These columns give the platform the two timestamps it needs to enforce
-- published limits (confirm within 72h, dispatch within 7 days of confirming,
-- deliver within 30 days), a record of which limit ran out, and the link
-- between a delivered order and the replacement raised for it.
--
-- Every column is nullable and every enum change is additive, so existing rows
-- stay valid and nothing needs backfilling. Orders confirmed before
-- `confirmed_at` existed have no dispatch clock at all - the service falls
-- back to the 30-day limit for those rather than back-dating them into an
-- instant cancellation.

ALTER TYPE "public"."order_status" ADD VALUE IF NOT EXISTS 'Exchanged';
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."cancel_reason" AS ENUM (
    'seller',
    'buyer',
    'payment_expired',
    'auto_unconfirmed',
    'auto_undispatched',
    'auto_undelivered'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "confirmed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "cancelled_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "cancel_reason" "public"."cancel_reason";
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "exchanged_from_order_id" uuid;
--> statement-breakpoint
-- The sweep asks "which live orders are overdue" across every shop at once,
-- so it needs status with age and without a shop to narrow it first.
CREATE INDEX IF NOT EXISTS "orders_status_placed_idx" ON "orders" ("status","placed_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_status_confirmed_idx" ON "orders" ("status","confirmed_at");
