-- Keep checkout references intact so late payments can still be reconciled.
ALTER TABLE "payment_links" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;
