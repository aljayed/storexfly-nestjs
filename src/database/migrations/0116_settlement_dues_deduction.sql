-- Payouts are sent net of what the shop owes on money it collected itself.
ALTER TABLE "settlements" ADD COLUMN IF NOT EXISTS "dues_deducted_cents" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "service_fee_payments" ADD COLUMN IF NOT EXISTS "payout_period" varchar(7);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "service_fee_payments_payout_idx" ON "service_fee_payments" ("shop_id", "payout_period");
