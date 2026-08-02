-- The verified track's rate becomes an operator setting instead of a constant,
-- so it can be tuned from the platform console without a deploy. It lives on
-- the platform_settings singleton next to the other platform-wide numbers.
--
-- 150 basis points = 1.5%, which is what the constant was.
--
-- The dead `monthly_fee_cents` column goes at the same time: there has been no
-- monthly fee since migration 0060, and leaving a column by that name on the
-- settings table only misleads whoever reads it next.
--
-- Idempotent by convention: re-running changes nothing.

ALTER TABLE "platform_settings"
  ADD COLUMN IF NOT EXISTS "commission_bps" integer DEFAULT 150 NOT NULL;--> statement-breakpoint

-- Same normalisation guard as 0060: if the column already exists from an
-- earlier experiment, ADD COLUMN IF NOT EXISTS above did nothing, so make sure
-- it carries the default and the NOT NULL this code relies on.
UPDATE "platform_settings" SET "commission_bps" = 150 WHERE "commission_bps" IS NULL;--> statement-breakpoint
ALTER TABLE "platform_settings" ALTER COLUMN "commission_bps" SET DEFAULT 150;--> statement-breakpoint
ALTER TABLE "platform_settings" ALTER COLUMN "commission_bps" SET NOT NULL;--> statement-breakpoint

ALTER TABLE "platform_settings" DROP COLUMN IF EXISTS "monthly_fee_cents";
