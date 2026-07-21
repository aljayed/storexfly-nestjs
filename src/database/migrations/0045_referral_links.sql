-- Referral links: shareable URLs (hoomri.com/r/<slug>) each tied to a coupon.
-- Opening one quotes a discounted first month and auto-applies the coupon to
-- the shop-creation payment; renewals stay full price.
-- Idempotent: every statement is safe to re-run.

CREATE TABLE IF NOT EXISTS "referral_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(60) NOT NULL,
	"name" varchar(120),
	"coupon_id" uuid NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"clicks" integer DEFAULT 0 NOT NULL,
	"signups" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "referral_links" ADD CONSTRAINT "referral_links_coupon_id_coupons_id_fk"
    FOREIGN KEY ("coupon_id") REFERENCES "public"."coupons"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "referral_links_slug_unique_idx"
  ON "referral_links" USING btree ("slug");
