-- Seller-entered "compare at" (regular) price shown struck through on the
-- storefront. Null = no discount display. Replaces the storefront's old
-- fabricated list price (price × 1.2). Idempotent by convention.
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "compare_price_cents" integer;
