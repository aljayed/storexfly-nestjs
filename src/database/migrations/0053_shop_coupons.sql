-- Shop-owned, buyer-facing discount codes. Separate from the platform
-- `coupons` table (which discounts seller subscription payments): these
-- discount a storefront order's item subtotal, never delivery.
--
-- Scope is either the whole order ('all' - showcase items never reach
-- checkout, so they are excluded by construction), one product, or one combo.
-- Hand-written and idempotent.

DO $$ BEGIN
  CREATE TYPE "public"."shop_coupon_scope" AS ENUM('all', 'product', 'combo');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "public"."shop_coupon_type" AS ENUM('percent', 'fixed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "shop_coupons" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE cascade,
  "code" varchar(40) NOT NULL,
  "description" varchar(200),
  "discount_type" "shop_coupon_type" DEFAULT 'percent' NOT NULL,
  "value" integer NOT NULL,
  "max_discount_cents" integer,
  "min_order_cents" integer DEFAULT 0 NOT NULL,
  "scope" "shop_coupon_scope" DEFAULT 'all' NOT NULL,
  "product_id" uuid REFERENCES "products"("id") ON DELETE cascade,
  "combo_id" uuid REFERENCES "combos"("id") ON DELETE cascade,
  "active" boolean DEFAULT true NOT NULL,
  "starts_at" timestamp with time zone,
  "expires_at" timestamp with time zone,
  "max_redemptions" integer,
  "redemptions" integer DEFAULT 0 NOT NULL,
  "per_customer_limit" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "shop_coupons_shop_code_unique_idx"
  ON "shop_coupons" ("shop_id", "code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_coupons_shop_idx"
  ON "shop_coupons" ("shop_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "shop_coupon_redemptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "coupon_id" uuid NOT NULL REFERENCES "shop_coupons"("id") ON DELETE cascade,
  "order_id" uuid NOT NULL REFERENCES "orders"("id") ON DELETE cascade,
  "phone" varchar(24) NOT NULL,
  "discount_cents" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "shop_coupon_redemptions_coupon_phone_idx"
  ON "shop_coupon_redemptions" ("coupon_id", "phone");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shop_coupon_redemptions_order_unique_idx"
  ON "shop_coupon_redemptions" ("order_id");--> statement-breakpoint

-- The redeemed code + the discount already subtracted from `total_cents`.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "coupon_code" varchar(40);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "discount_cents" integer DEFAULT 0 NOT NULL;
