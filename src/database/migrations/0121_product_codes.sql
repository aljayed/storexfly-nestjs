-- Optional seller identifiers on a product: their own stock code and the
-- barcode printed on the pack. Variant-level codes live in the
-- variant_combinations JSON and need no column.
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "sku" varchar(64);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "barcode" varchar(64);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "products_shop_barcode_idx" ON "products" ("shop_id", "barcode");
