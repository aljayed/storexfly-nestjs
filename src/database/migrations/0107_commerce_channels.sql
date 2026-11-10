ALTER TABLE "products" ADD COLUMN "commerce" jsonb NOT NULL DEFAULT '{"channels":["retail"]}'::jsonb;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "commerce_mode" varchar(16) NOT NULL DEFAULT 'retail';
--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_commerce_mode_check" CHECK ("commerce_mode" IN ('retail', 'reseller', 'wholesale'));
--> statement-breakpoint
CREATE INDEX "products_commerce_channels_idx" ON "products" USING gin (("commerce"->'channels'));
--> statement-breakpoint
CREATE TABLE "reseller_listings" (
 "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE RESTRICT,
 "product_id" uuid NOT NULL REFERENCES "products"("id") ON DELETE RESTRICT, "selling_price_cents" integer NOT NULL CHECK (selling_price_cents >= 0),
 "active" boolean NOT NULL DEFAULT true, "created_at" timestamptz NOT NULL DEFAULT now(), "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "reseller_listings_shop_product_idx" ON "reseller_listings" ("shop_id", "product_id");
--> statement-breakpoint
CREATE TABLE "trade_quotes" (
 "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "buyer_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
 "shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE RESTRICT, "product_id" uuid NOT NULL REFERENCES "products"("id") ON DELETE RESTRICT,
 "kind" varchar(16) NOT NULL DEFAULT 'bulk' CHECK (kind IN ('bulk','sample')), "qty" integer NOT NULL CHECK (qty > 0), "variant" jsonb NOT NULL DEFAULT '{}',
 "message" text NOT NULL, "status" varchar(16) NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','quoted','accepted','declined','cancelled')),
 "unit_price_cents" integer CHECK (unit_price_cents >= 0), "expires_at" timestamptz, "used_at" timestamptz,
 "created_at" timestamptz NOT NULL DEFAULT now(), "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "trade_quotes_buyer_idx" ON "trade_quotes" ("buyer_id", "created_at");
--> statement-breakpoint
CREATE INDEX "trade_quotes_supplier_idx" ON "trade_quotes" ("shop_id", "created_at");
--> statement-breakpoint
CREATE TABLE "trade_messages" (
 "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "quote_id" uuid NOT NULL REFERENCES "trade_quotes"("id") ON DELETE CASCADE,
 "sender" varchar(16) NOT NULL CHECK (sender IN ('buyer','supplier')), "text" text NOT NULL, "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "trade_disputes" (
 "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "order_id" uuid NOT NULL REFERENCES "orders"("id") ON DELETE RESTRICT,
 "buyer_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT, "shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE RESTRICT,
 "reason" text NOT NULL, "status" varchar(16) NOT NULL DEFAULT 'open' CHECK (status IN ('open','proposed','escalated','resolved')), "resolution" text,
 "created_at" timestamptz NOT NULL DEFAULT now(), "resolved_at" timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX "trade_disputes_order_idx" ON "trade_disputes" ("order_id");
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "reseller_shop_id" uuid REFERENCES "shops"("id") ON DELETE RESTRICT,
 ADD COLUMN "reseller_listing_id" uuid REFERENCES "reseller_listings"("id") ON DELETE RESTRICT,
 ADD COLUMN "reseller_margin_cents" integer NOT NULL DEFAULT 0 CHECK (reseller_margin_cents >= 0),
 ADD COLUMN "trade_quote_id" uuid REFERENCES "trade_quotes"("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX "orders_trade_quote_unique_idx" ON "orders" ("trade_quote_id");
--> statement-breakpoint
CREATE INDEX "orders_reseller_shop_idx" ON "orders" ("reseller_shop_id", "placed_at");
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "buyer_shop" jsonb;
