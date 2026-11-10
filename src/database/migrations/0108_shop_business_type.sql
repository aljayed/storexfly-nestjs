ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "business_type" varchar(16) NOT NULL DEFAULT 'retail';
--> statement-breakpoint
ALTER TABLE "shops" DROP CONSTRAINT IF EXISTS "shops_business_type_check";
--> statement-breakpoint
ALTER TABLE "shops" ADD CONSTRAINT "shops_business_type_check" CHECK ("business_type" IN ('retail', 'wholesale', 'reseller'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_shop_mode_placed_idx" ON "orders" ("shop_id", "commerce_mode", "placed_at");
