-- A seller can pay for the same held shop more than once - two tabs, two
-- payment pages, both completed. Only one pack may open the shop: the latest
-- one. Every earlier payment stays in the ledger, marked invalid, and can be
-- refunded from the shop console.
--
-- voided_at / void_reason: set on a payment that bought nothing. 'replaced'
--   means a later payment for the same shop opening took its place;
--   'duplicate' means this payment itself could not be applied.
-- shop_draft_id: which held shop an opening payment was for, so a later
--   payment for the same one can find the pack it replaces.
ALTER TABLE "subscription_payments" ADD COLUMN IF NOT EXISTS "voided_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "subscription_payments" ADD COLUMN IF NOT EXISTS "void_reason" varchar(40);
--> statement-breakpoint
ALTER TABLE "subscription_payments" ADD COLUMN IF NOT EXISTS "shop_draft_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "subscription_payments" ADD CONSTRAINT "subscription_payments_shop_draft_id_shop_drafts_id_fk"
    FOREIGN KEY ("shop_draft_id") REFERENCES "public"."shop_drafts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscription_payments_draft_idx" ON "subscription_payments" USING btree ("shop_draft_id");
--> statement-breakpoint
-- A refund can now send back a platform payment as well as a buyer's order.
ALTER TABLE "payment_refunds" ADD COLUMN IF NOT EXISTS "subscription_payment_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_subscription_payment_id_subscription_payments_id_fk"
    FOREIGN KEY ("subscription_payment_id") REFERENCES "public"."subscription_payments"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_refunds_platform_payment_idx" ON "payment_refunds" USING btree ("subscription_payment_id");
--> statement-breakpoint
-- One live refund per platform payment: a double click, or two tabs, cannot
-- file it twice. A refund the gateway refused ('failed') may be tried again.
CREATE UNIQUE INDEX IF NOT EXISTS "payment_refunds_platform_payment_live_idx"
  ON "payment_refunds" USING btree ("subscription_payment_id")
  WHERE "subscription_payment_id" IS NOT NULL AND "status" <> 'failed';
