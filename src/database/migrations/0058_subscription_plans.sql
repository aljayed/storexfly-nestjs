-- The platform moves from one flat monthly fee to a five-rung plan ladder
-- priced by how much a shop sells in a billing period:
--
--   Starter    up to ৳1,00,000/mo    ৳599
--   Growth     up to ৳2,50,000/mo    ৳1,199
--   Business   up to ৳5,00,000/mo    ৳2,499
--   Scale      up to ৳10,00,000/mo   ৳4,599
--   Unlimited  no cap                ৳11,990
--
-- Sellers upgrade instantly (paying the prorated difference), downgrade at the
-- end of the period they already paid for, and can opt into auto-scale, which
-- moves them up a rung when their sales reach the current cap.
--
-- Idempotent by convention: re-running changes nothing.

CREATE TABLE IF NOT EXISTS "subscription_plans" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "code" varchar(32) NOT NULL,
  "name" varchar(60) NOT NULL,
  "sales_cap_cents" bigint,
  "price_cents" integer NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "subscription_plans_code_unique_idx" ON "subscription_plans" ("code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscription_plans_sort_idx" ON "subscription_plans" ("sort_order");--> statement-breakpoint

-- The ladder. ON CONFLICT DO NOTHING keeps an operator's re-pricing intact if
-- this ever runs again.
INSERT INTO "subscription_plans" ("code", "name", "sales_cap_cents", "price_cents", "sort_order")
VALUES
  ('starter',   'Starter',    10000000,  59900,   1),
  ('growth',    'Growth',     25000000,  119900,  2),
  ('business',  'Business',   50000000,  249900,  3),
  ('scale',     'Scale',      100000000, 459900,  4),
  ('unlimited', 'Unlimited',  NULL,      1199000, 5)
ON CONFLICT ("code") DO NOTHING;--> statement-breakpoint

-- ── Subscriptions carry their rung, their parked downgrade and auto-scale ──
ALTER TABLE "subscriptions"
  ADD COLUMN IF NOT EXISTS "plan_code" varchar(32) DEFAULT 'starter' NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions"
  ADD COLUMN IF NOT EXISTS "scheduled_plan_code" varchar(32);--> statement-breakpoint
ALTER TABLE "subscriptions"
  ADD COLUMN IF NOT EXISTS "auto_scale" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions"
  ADD COLUMN IF NOT EXISTS "cap_exceeded_at" timestamp with time zone;--> statement-breakpoint

-- Everyone already paying was on the single flat fee, which is now the entry
-- rung - put them on Starter at Starter's price. Cancelled subscriptions keep
-- their historical amount; recorded payments are never rewritten.
UPDATE "subscriptions" SET "plan_code" = 'starter', "amount_cents" = 59900
  WHERE "status" <> 'cancelled' AND "amount_cents" <> 59900;--> statement-breakpoint

-- A coupon applied at the old price must never out-discount the new one:
-- renewals charge amount - pending_discount, which cannot go negative.
UPDATE "subscriptions" SET "pending_discount_cents" = "amount_cents"
  WHERE "pending_discount_cents" > "amount_cents";--> statement-breakpoint

-- ── The ledger records which plan a payment bought ──
ALTER TYPE "public"."platform_payment_type" ADD VALUE IF NOT EXISTS 'upgrade';--> statement-breakpoint
ALTER TABLE "subscription_payments"
  ADD COLUMN IF NOT EXISTS "plan_code" varchar(32);
