-- Drop the public approval-link token added in 0047. Guest orders can't use
-- the buyer-approval flow at all now (approval is an account-only action), so
-- there is no public link and no token. Hand-written and idempotent.

DROP INDEX IF EXISTS "order_amount_adjustments_token_unique_idx";--> statement-breakpoint
ALTER TABLE "order_amount_adjustments" DROP COLUMN IF EXISTS "token";
