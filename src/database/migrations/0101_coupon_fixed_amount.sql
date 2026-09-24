-- A platform coupon can take a fixed amount off instead of a percentage.
--
-- Exactly one of percent_off / amount_off_cents is set on every coupon, so a
-- code always means one thing. Existing coupons are all percentage coupons
-- and keep working unchanged.
ALTER TABLE "coupons" ADD COLUMN IF NOT EXISTS "amount_off_cents" integer;
--> statement-breakpoint
ALTER TABLE "coupons" ALTER COLUMN "percent_off" DROP NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "coupons" ADD CONSTRAINT "coupons_one_discount_chk"
    CHECK ((("percent_off" IS NULL) <> ("amount_off_cents" IS NULL))
      AND ("percent_off" IS NULL OR "percent_off" BETWEEN 1 AND 100)
      AND ("amount_off_cents" IS NULL OR "amount_off_cents" > 0));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
