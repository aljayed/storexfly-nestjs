-- Zones are measured from the shop's own dispatch city rather than always
-- from Dhaka, and the shop sets the default charge for each zone. Items keep
-- a charge of their own only where the seller gave them one.
--
-- Nothing a buyer pays changes today: every nationwide shop is pinned to
-- Dhaka at the platform's ৳70 inside rate (what its "Standard" items charged),
-- and a city-only shop's city rate becomes its inside rate - which is what a
-- city-only shop charges. See common/constants/delivery.ts.
UPDATE "shops" SET "delivery_city" = 'Dhaka', "delivery_city_cents" = 7000 WHERE "delivery_coverage" = 'nationwide' OR "delivery_city" IS NULL;
--> statement-breakpoint
ALTER TABLE "shops" RENAME COLUMN "delivery_city_cents" TO "delivery_inside_cents";
--> statement-breakpoint
ALTER TABLE "shops" ALTER COLUMN "delivery_city" SET DEFAULT 'Dhaka';
--> statement-breakpoint
ALTER TABLE "shops" ALTER COLUMN "delivery_city" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "delivery_outside_cents" integer DEFAULT 12000 NOT NULL CHECK (delivery_outside_cents >= 0);
--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "delivery_dhaka_cents" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "delivery_dhaka_cents" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "delivery_outside_cents" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "delivery_outside_cents" DROP DEFAULT;
--> statement-breakpoint
-- A city-only item (its own choice or its shop's) charged its city rate: its
-- own, or the shop's when it had none. That is now its inside charge.
UPDATE "products" p SET "delivery_dhaka_cents" = p."delivery_city_cents"
  FROM "shops" s
  WHERE s."id" = p."shop_id"
    AND (p."delivery_coverage" = 'city' OR (p."delivery_coverage" IS NULL AND s."delivery_coverage" = 'city'));
--> statement-breakpoint
-- The old "Standard" pair is exactly what a shop charges by default, so those
-- items follow their shop from here on.
UPDATE "products" SET "delivery_dhaka_cents" = NULL, "delivery_outside_cents" = NULL
  WHERE "delivery_dhaka_cents" = 7000 AND "delivery_outside_cents" = 12000;
--> statement-breakpoint
-- "One city only" on an item now means its shop's city.
ALTER TABLE "products" DROP COLUMN IF EXISTS "delivery_city";
--> statement-breakpoint
ALTER TABLE "products" DROP COLUMN IF EXISTS "delivery_city_cents";
