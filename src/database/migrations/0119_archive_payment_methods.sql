-- Preserve method codes and collection routes for orders and settlements.
ALTER TABLE "payment_methods" ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;
