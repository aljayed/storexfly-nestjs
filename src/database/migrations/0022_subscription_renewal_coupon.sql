ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "pending_coupon_id" uuid;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "pending_coupon_code" varchar(40);--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "pending_discount_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_pending_coupon_id_coupons_id_fk" FOREIGN KEY ("pending_coupon_id") REFERENCES "public"."coupons"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
