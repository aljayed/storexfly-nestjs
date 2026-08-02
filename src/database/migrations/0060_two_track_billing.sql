-- The platform drops the monthly subscription ladder and moves to two ways of
-- paying for the sales a shop makes:
--
--   credits     Open to every seller, no verification. The shop buys sales
--               credit up front and every taka it sells draws it down.
--               ৳1,899 buys ৳1,00,000 of selling; ৳3,499 buys ৳2,00,000;
--               ৳8,299 buys ৳5,00,000. A shop may hold at most ৳10,00,000 of
--               credit at once - a ceiling on the balance, not a lifetime cap,
--               so selling it down opens room to buy again.
--
--   commission  Only for shops with a verified trade licence. Nothing up
--               front; at the end of each billing month the shop is billed a
--               flat 1.5% of what it sold that month, and has 25 days to
--               settle it by hand if the automatic charge doesn't land.
--
-- Credit already bought survives the move to the verified track: sales draw
-- the balance down first and commission only starts once it runs out.
--
-- Creating a shop is now free. New shops open on the credits track with a zero
-- balance, on the existing free trial (1 product, 10 lifetime orders), and buy
-- their first pack when they are ready to sell properly.
--
-- Idempotent by convention: re-running changes nothing.

-- ── Enums ─────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "public"."billing_mode" AS ENUM ('credits', 'commission');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

-- Append-only in Postgres, so the new payment types sit after the retired ones.
ALTER TYPE "public"."platform_payment_type" ADD VALUE IF NOT EXISTS 'credit_pack';--> statement-breakpoint
ALTER TYPE "public"."platform_payment_type" ADD VALUE IF NOT EXISTS 'commission';--> statement-breakpoint

-- ── The credit pack catalogue ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS "credit_packs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "code" varchar(32) NOT NULL,
  "name" varchar(60) NOT NULL,
  "sales_credit_cents" bigint NOT NULL,
  "price_cents" integer NOT NULL,
  "badge" varchar(40),
  "sort_order" integer DEFAULT 0 NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "credit_packs_code_unique_idx" ON "credit_packs" ("code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_packs_sort_idx" ON "credit_packs" ("sort_order");--> statement-breakpoint

-- ON CONFLICT DO NOTHING keeps an operator's re-pricing intact if this reruns.
INSERT INTO "credit_packs" ("code", "name", "sales_credit_cents", "price_cents", "badge", "sort_order")
VALUES
  ('credit-100k', '৳1,00,000 in sales', 10000000, 189900, NULL,           1),
  ('credit-200k', '৳2,00,000 in sales', 20000000, 349900, 'Most popular', 2),
  ('credit-500k', '৳5,00,000 in sales', 50000000, 829900, 'Best value',   3)
ON CONFLICT ("code") DO NOTHING;--> statement-breakpoint

-- ── Subscriptions carry a track instead of a rung ─────────────────
ALTER TABLE "subscriptions"
  ADD COLUMN IF NOT EXISTS "billing_mode" "public"."billing_mode" DEFAULT 'credits' NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions"
  ADD COLUMN IF NOT EXISTS "credit_granted_cents" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions"
  ADD COLUMN IF NOT EXISTS "meter_start_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions"
  ADD COLUMN IF NOT EXISTS "credit_exhausted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscriptions"
  ADD COLUMN IF NOT EXISTS "commission_bps" integer DEFAULT 150 NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions"
  ADD COLUMN IF NOT EXISTS "due_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Some databases already carry a stray, nullable `due_cents` from an earlier
-- experiment, in which case ADD COLUMN IF NOT EXISTS above did nothing and
-- left it without the default or the NOT NULL this code relies on. Normalise
-- it either way - the statements are no-ops on a column that is already right.
UPDATE "subscriptions" SET "due_cents" = 0 WHERE "due_cents" IS NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ALTER COLUMN "due_cents" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "subscriptions" ALTER COLUMN "due_cents" SET NOT NULL;--> statement-breakpoint
-- Same origin: a prepaid counter this model replaces with credit_granted_cents.
ALTER TABLE "subscriptions" DROP COLUMN IF EXISTS "prepaid_cents";--> statement-breakpoint
ALTER TABLE "subscriptions"
  ADD COLUMN IF NOT EXISTS "due_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscriptions"
  ADD COLUMN IF NOT EXISTS "due_period_start" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscriptions"
  ADD COLUMN IF NOT EXISTS "due_period_end" timestamp with time zone;--> statement-breakpoint

-- Existing shops move onto the credits track. Their meter starts now, so the
-- sales they already made never eat credit they buy from here on; a verified
-- shop can switch itself to commission from the console whenever it likes.
UPDATE "subscriptions"
  SET "meter_start_at" = now()
  WHERE "meter_start_at" < "started_at";--> statement-breakpoint

-- A seller who pre-paid a monthly fee that now buys nothing is handed the
-- equivalent in sales credit rather than losing it: one entry-plan fee (৳599)
-- bought a month of selling up to ৳1,00,000, so that is what it becomes.
UPDATE "subscriptions"
  SET "credit_granted_cents" = 10000000
  WHERE "status" <> 'cancelled' AND "credit_granted_cents" = 0;--> statement-breakpoint

-- ── The ledger records packs and commission bills ─────────────────
ALTER TABLE "subscription_payments"
  ADD COLUMN IF NOT EXISTS "sales_credit_cents" bigint;--> statement-breakpoint
ALTER TABLE "subscription_payments"
  ADD COLUMN IF NOT EXISTS "billable_sales_cents" bigint;--> statement-breakpoint

-- ── Retire the plan ladder ────────────────────────────────────────
-- Recorded payments keep their historical plan_code; only the live
-- subscription columns go. Coupons now apply at credit-pack checkout, so the
-- pending-renewal-coupon columns go with them.
ALTER TABLE "subscriptions" DROP COLUMN IF EXISTS "plan_code";--> statement-breakpoint
ALTER TABLE "subscriptions" DROP COLUMN IF EXISTS "scheduled_plan_code";--> statement-breakpoint
ALTER TABLE "subscriptions" DROP COLUMN IF EXISTS "amount_cents";--> statement-breakpoint
ALTER TABLE "subscriptions" DROP COLUMN IF EXISTS "auto_scale";--> statement-breakpoint
ALTER TABLE "subscriptions" DROP COLUMN IF EXISTS "auto_reset";--> statement-breakpoint
ALTER TABLE "subscriptions" DROP COLUMN IF EXISTS "cap_exceeded_at";--> statement-breakpoint
ALTER TABLE "subscriptions" DROP COLUMN IF EXISTS "pending_coupon_id";--> statement-breakpoint
ALTER TABLE "subscriptions" DROP COLUMN IF EXISTS "pending_coupon_code";--> statement-breakpoint
ALTER TABLE "subscriptions" DROP COLUMN IF EXISTS "pending_discount_cents";--> statement-breakpoint
DROP TABLE IF EXISTS "subscription_plans";
