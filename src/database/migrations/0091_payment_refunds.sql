-- Refunds, as records rather than as a flag.
--
-- An order's `pay` column says whether the shop still owns the money. It does
-- not say where the money is: SSLCommerz answers "success" to mean it has
-- accepted a refund request, and the cardholder sees it days later. This table
-- is the other half of that - one row per attempt to send money back, carried
-- from filed to actually-paid by a slow poll.
--
-- `refund_trans_id` is ours and is what the gateway's mandatory
-- `refund_trans_id` carries. It is written before the gateway is called, which
-- is what makes a retry safe: the same id filed twice is answered "processing"
-- for the existing refund rather than paying the buyer a second time.

CREATE TABLE IF NOT EXISTS "payment_refunds" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "order_id" uuid,
  "transaction_id" uuid,
  "provider" varchar(20) NOT NULL,
  "refund_trans_id" varchar(30) NOT NULL,
  "refund_ref_id" varchar(60),
  "bank_tran_id" varchar(80),
  "amount_cents" integer NOT NULL,
  "status" varchar(20) DEFAULT 'requested' NOT NULL,
  "reason" varchar(255),
  "error_reason" varchar(500),
  "initiated_by" varchar(20) DEFAULT 'seller' NOT NULL,
  "requested_at" timestamp with time zone DEFAULT now() NOT NULL,
  "settled_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_order_id_orders_id_fk"
    FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_transaction_id_payment_transactions_id_fk"
    FOREIGN KEY ("transaction_id") REFERENCES "public"."payment_transactions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
-- The idempotency key. Unique forever, not just per order.
CREATE UNIQUE INDEX IF NOT EXISTS "payment_refunds_trans_unique_idx" ON "payment_refunds" ("refund_trans_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_refunds_order_idx" ON "payment_refunds" ("order_id");
--> statement-breakpoint
-- The poll that chases filed refunds to a conclusion.
CREATE INDEX IF NOT EXISTS "payment_refunds_status_idx" ON "payment_refunds" ("status","requested_at");
