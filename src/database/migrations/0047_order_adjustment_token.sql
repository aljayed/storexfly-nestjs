-- Public approval-link token for order-amount changes. Guest orders have no
-- buyer account, so the in-app approval path can't reach them — the seller
-- shares this token as a link (webUrl/approve/<token>) instead. Hand-written
-- and idempotent; safe to re-run.

ALTER TABLE "order_amount_adjustments" ADD COLUMN IF NOT EXISTS "token" varchar(64);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "order_amount_adjustments_token_unique_idx"
  ON "order_amount_adjustments" USING btree ("token");
