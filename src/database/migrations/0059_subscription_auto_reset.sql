-- Auto-reset: an opt-in companion to auto-scale. On every billing date the
-- shop drops back to the entry plan and is charged only that; auto-scale then
-- climbs the ladder again as the month's sales come in. A seller who peaked at
-- ৳2,499 last month therefore pays ৳599 for a quiet one.
--
-- It is meaningless on its own — nothing would ever put the shop back up — so
-- it can only be on while auto_scale is on, enforced in the service and by the
-- backfill below.
-- Idempotent by convention.

ALTER TABLE "subscriptions"
  ADD COLUMN IF NOT EXISTS "auto_reset" boolean DEFAULT false NOT NULL;--> statement-breakpoint

-- Belt and braces: never leave a shop resetting to the entry plan with nothing
-- to lift it back up.
UPDATE "subscriptions" SET "auto_reset" = false
  WHERE "auto_reset" = true AND "auto_scale" = false;
