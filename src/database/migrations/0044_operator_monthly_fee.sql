-- The monthly platform fee moves from a compile-time constant to the
-- platform-settings singleton so an operator can change it from the console.
-- Price drops ৳1,199 → ৳599: the new default, the stored singleton, and every
-- live subscription all move together (one plan, one price). Cancelled
-- subscriptions and recorded payments keep their historical amounts.
-- Idempotent by convention.
ALTER TABLE "platform_settings"
  ADD COLUMN IF NOT EXISTS "monthly_fee_cents" integer DEFAULT 59900 NOT NULL;

ALTER TABLE "subscriptions" ALTER COLUMN "amount_cents" SET DEFAULT 59900;

-- Re-price only where the old fee is still in force, so re-running this (or
-- running it after the operator has already set their own price) is a no-op.
UPDATE "platform_settings" SET "monthly_fee_cents" = 59900
  WHERE "monthly_fee_cents" = 119900;

UPDATE "subscriptions" SET "amount_cents" = 59900
  WHERE "amount_cents" = 119900 AND "status" <> 'cancelled';

-- A coupon applied before a price drop can out-discount the new fee; renewals
-- charge amount - pending_discount, which must never go negative.
UPDATE "subscriptions" SET "pending_discount_cents" = "amount_cents"
  WHERE "pending_discount_cents" > "amount_cents";

-- Unconsumed shop-creation credits are pre-payments for a shop that does not
-- exist yet; charge them the new price too (discounted ones are left alone).
UPDATE "subscription_payments" SET "amount_cents" = 59900
  WHERE "amount_cents" = 119900
    AND "type" = 'shop_creation'
    AND "consumed_at" IS NULL
    AND "discount_cents" = 0;
