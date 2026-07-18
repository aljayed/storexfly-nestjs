-- Sellers can now enable/disable and re-word the product-page "why buy" strip
-- (packed fresh, fast delivery, …) from the shop console. Stored as a small
-- jsonb array of { icon, title, subtitle, enabled }, capped at 4 in the API.
-- Null = never customised, so the storefront shows its translated defaults.
-- Hand-written and idempotent (see 0025 for why we avoid `drizzle-kit generate`).
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "trust_badges" jsonb;
