-- Variants, multi-buy packs, and combo offers.
--   • products.variant_groups - jsonb [{ id, name, options: [{ id, label, priceDeltaCents }] }]
--     (≤ 2 buyer-facing option groups; deltas adjust the base unit price)
--   • products.packs - jsonb [{ id, label, units, priceCents }] (multi-buy bundles)
--   • order_items.variant - snapshot of what was picked ("Size: L · Pack of 3")
--   • combos / combo_items - 2+ shop items sold together at a special price
-- Hand-written and idempotent (see 0025 for why we avoid `drizzle-kit generate`).
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "variant_groups" jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "packs" jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "variant" varchar(240);

CREATE TABLE IF NOT EXISTS "combos" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE CASCADE,
  "name" varchar(160) NOT NULL,
  "blurb" text NOT NULL DEFAULT '',
  "emoji" varchar(16) NOT NULL DEFAULT '🎁',
  "price_cents" integer NOT NULL,
  "active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "combos_shop_idx" ON "combos" ("shop_id");

CREATE TABLE IF NOT EXISTS "combo_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "combo_id" uuid NOT NULL REFERENCES "combos"("id") ON DELETE CASCADE,
  "product_id" uuid NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
  "qty" integer NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS "combo_items_combo_idx" ON "combo_items" ("combo_id");
