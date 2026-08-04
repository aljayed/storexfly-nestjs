-- Drop the default SSLCommerz (card) processing fee from 4.5% to 3.5%.
--
-- Three places carry that number: the column defaults on `platform_settings`
-- and `settlements` (used when a row is inserted without an explicit fee), and
-- the live `payment_methods` catalog row, which is what checkout and settlement
-- snapshots actually read. The catalog row is only moved when it still holds the
-- old default of 450 bp - an operator who has deliberately set some other rate
-- in the platform console keeps it.
--
-- Idempotent by convention: re-running changes nothing.

ALTER TABLE "platform_settings" ALTER COLUMN "card_fee_bp" SET DEFAULT 350;--> statement-breakpoint
ALTER TABLE "settlements" ALTER COLUMN "card_fee_bp" SET DEFAULT 350;--> statement-breakpoint
UPDATE "platform_settings" SET "card_fee_bp" = 350 WHERE "card_fee_bp" = 450;--> statement-breakpoint
UPDATE "payment_methods" SET "fee_bp" = 350, "updated_at" = now() WHERE "code" = 'card' AND "fee_bp" = 450;
