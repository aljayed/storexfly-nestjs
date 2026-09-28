-- Where a shop delivers: all of Bangladesh (every shop until now, and the
-- default) or only inside one city at one flat charge. A product may override
-- the shop either way; its three columns stay NULL, meaning "as my shop does",
-- until the seller says otherwise. See common/constants/delivery.ts.
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "delivery_coverage" varchar(16) DEFAULT 'nationwide' NOT NULL CHECK (delivery_coverage IN ('nationwide', 'city'));
--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "delivery_city" varchar(80);
--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "delivery_city_cents" integer DEFAULT 7000 NOT NULL CHECK (delivery_city_cents >= 0);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "delivery_coverage" varchar(16) CHECK (delivery_coverage IN ('nationwide', 'city'));
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "delivery_city" varchar(80);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "delivery_city_cents" integer CHECK (delivery_city_cents >= 0);
