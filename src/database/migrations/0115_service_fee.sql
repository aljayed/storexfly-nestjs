-- Service fee: 4.5% of what a shop sells, inclusive of payment processing.
-- Online payments have it deducted from the payout; money the seller
-- collects themself (cash on delivery, direct transfer) leaves them owing it.

-- The rate each order was placed under. Everything already in the table was
-- sold while the platform was free, so it is stamped zero and owes nothing;
-- only orders placed from here on carry the fee.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "platform_fee_bp" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "platform_fee_bp" SET DEFAULT 450;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "dues_paid_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "suspended_for" varchar(20);
--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "dues_over_since" timestamp with time zone;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "service_fee_payments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE CASCADE,
  "amount_cents" integer NOT NULL,
  "via" varchar(12) NOT NULL,
  "gateway" varchar(20),
  "gateway_txn_id" varchar(80),
  "payment_transaction_id" uuid REFERENCES "payment_transactions"("id") ON DELETE SET NULL,
  "note" varchar(200),
  "recorded_by" varchar(254),
  "paid_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "service_fee_payments_shop_idx" ON "service_fee_payments" ("shop_id", "paid_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "service_fee_payments_txn_unique_idx" ON "service_fee_payments" ("gateway", "gateway_txn_id");
--> statement-breakpoint
-- The fee is inclusive of payment processing, so every gateway-collected
-- method is brought up to it. A method an operator has already priced above
-- the floor is left alone.
UPDATE "payment_methods" SET "fee_bp" = 450 WHERE "gateway" <> 'none' AND "fee_bp" < 450;
