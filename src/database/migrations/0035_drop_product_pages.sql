-- The custom page builder feature was removed: buyers always get the default
-- product page. Drops the per-product template wiring and the pages table.
ALTER TABLE "products" DROP COLUMN IF EXISTS "page_template";
--> statement-breakpoint
ALTER TABLE "products" DROP COLUMN IF EXISTS "product_page_id";
--> statement-breakpoint
DROP TABLE IF EXISTS "product_pages";
