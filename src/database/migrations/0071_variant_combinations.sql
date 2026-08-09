-- Exact SKU-like combinations generated from product option groups.
-- Empty preserves the legacy per-option delta/stock behavior for old rows.
ALTER TABLE "products"
  ADD COLUMN IF NOT EXISTS "variant_combinations" jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE "order_items"
  ADD COLUMN IF NOT EXISTS "variant_combination_id" varchar(24);
