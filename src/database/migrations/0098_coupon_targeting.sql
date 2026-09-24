-- Who a platform coupon is for, and what it may be spent on.
--
-- All three are narrowing rules layered on the existing ones (active, expiry,
-- redemption cap, high-sales cutoff), and every existing coupon keeps working
-- exactly as before: not first-purchase-only, open to every seller, any pack.
--
-- first_purchase_only: only a seller who has never had a platform payment -
--   no credit pack, no commission bill, on any of their shops.
-- user_id: only this one account. Deleting the account deletes the coupon, so
--   a personal code can never fall open to everybody.
-- pack_codes: only these credit packs; NULL means any pack. Codes rather than
--   ids because the pack code is what the checkout and the ledger carry.
ALTER TABLE "coupons" ADD COLUMN IF NOT EXISTS "first_purchase_only" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "coupons" ADD COLUMN IF NOT EXISTS "user_id" uuid;
--> statement-breakpoint
ALTER TABLE "coupons" ADD COLUMN IF NOT EXISTS "pack_codes" varchar(32)[];
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "coupons" ADD CONSTRAINT "coupons_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "coupons_user_idx" ON "coupons" USING btree ("user_id");
