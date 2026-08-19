-- Payment history that records money, not sessions.
--
-- Why: `gateway_payments` is one row per checkout *session*, and a gateway
-- will settle the same session more than once. A real order here was paid
-- three times against a single `tran_id` after a broken redirect sent the
-- buyer back to retry - three genuine charges, of which the code recorded
-- one and silently dropped two. Money someone actually paid has to be
-- visible, so each transaction now gets its own row and shows up in the
-- payer's history exactly as it happened.
--
-- What is NOT repeated is the effect: an order still settles once however
-- many times it was paid for (guarded on the session, not on this table).
--
-- Sessions also become polymorphic, so a seller buying sales credit goes
-- through the same hosted checkout a buyer does instead of the dummy gateway
-- that granted credit without charging.
--
-- Idempotent by convention: re-running changes nothing.

-- ── Sessions: order payments, or a seller buying credit ───────────
-- order_id loses NOT NULL because a credit-pack session has no order.
ALTER TABLE "gateway_payments" ALTER COLUMN "order_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "gateway_payments"
  ADD COLUMN IF NOT EXISTS "purpose" varchar(20) DEFAULT 'order' NOT NULL;--> statement-breakpoint
ALTER TABLE "gateway_payments"
  ADD COLUMN IF NOT EXISTS "shop_id" uuid REFERENCES "shops"("id") ON DELETE cascade;--> statement-breakpoint
-- What the seller is buying. Held on the session rather than granted up
-- front, so an abandoned checkout grants nothing.
ALTER TABLE "gateway_payments"
  ADD COLUMN IF NOT EXISTS "pack_code" varchar(32);--> statement-breakpoint
ALTER TABLE "gateway_payments"
  ADD COLUMN IF NOT EXISTS "coupon_code" varchar(40);--> statement-breakpoint
ALTER TABLE "gateway_payments"
  ADD COLUMN IF NOT EXISTS "discount_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Referral attribution has to survive the redirect: the link is credited when
-- the money lands, not when the seller clicked buy.
ALTER TABLE "gateway_payments"
  ADD COLUMN IF NOT EXISTS "ref_slug" varchar(60);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gateway_payments_shop_idx"
  ON "gateway_payments" ("shop_id");--> statement-breakpoint

-- ── One row per charge that actually happened ─────────────────────
CREATE TABLE IF NOT EXISTS "payment_transactions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "gateway_payment_id" uuid NOT NULL REFERENCES "gateway_payments"("id") ON DELETE cascade,
  "purpose" varchar(20) DEFAULT 'order' NOT NULL,
  "order_id" uuid REFERENCES "orders"("id") ON DELETE set null,
  "shop_id" uuid REFERENCES "shops"("id") ON DELETE set null,
  "user_id" uuid REFERENCES "users"("id") ON DELETE set null,
  "provider" varchar(20) NOT NULL,
  "gateway_txn_id" varchar(80) NOT NULL,
  "val_id" varchar(80),
  "amount_cents" integer NOT NULL,
  "currency" varchar(3) DEFAULT 'BDT' NOT NULL,
  "instrument" varchar(60),
  "captured_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

-- The idempotency key: a redirect and an IPN describing the same charge
-- collapse to one row, while two real charges stay two rows.
CREATE UNIQUE INDEX IF NOT EXISTS "payment_transactions_provider_txn_unique_idx"
  ON "payment_transactions" ("provider", "gateway_txn_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_transactions_order_idx"
  ON "payment_transactions" ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_transactions_shop_idx"
  ON "payment_transactions" ("shop_id", "captured_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_transactions_user_idx"
  ON "payment_transactions" ("user_id", "captured_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_transactions_session_idx"
  ON "payment_transactions" ("gateway_payment_id");--> statement-breakpoint

-- ── The seller-facing ledger gains what the tile needs to read ────
ALTER TABLE "subscription_payments"
  ADD COLUMN IF NOT EXISTS "plan_name" varchar(60);--> statement-breakpoint
ALTER TABLE "subscription_payments"
  ADD COLUMN IF NOT EXISTS "payment_transaction_id" uuid
  REFERENCES "payment_transactions"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "subscription_payments"
  ADD COLUMN IF NOT EXISTS "gateway" varchar(20);--> statement-breakpoint
ALTER TABLE "subscription_payments"
  ADD COLUMN IF NOT EXISTS "gateway_txn_id" varchar(80);--> statement-breakpoint

-- Backfill the pack names already sold, so existing history reads properly.
UPDATE "subscription_payments" sp
   SET "plan_name" = cp."name"
  FROM "credit_packs" cp
 WHERE sp."plan_code" = cp."code" AND sp."plan_name" IS NULL;
