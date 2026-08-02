CREATE TABLE IF NOT EXISTS "payment_methods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(40) NOT NULL,
	"kind" "payment_method" NOT NULL,
	"title" varchar(80) NOT NULL,
	"subtitle" varchar(140),
	"fee_bp" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "payment_method" SET DATA TYPE varchar(40) USING "payment_method"::text;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN IF NOT EXISTS "settlement_banner" text;--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN IF NOT EXISTS "breakdown" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_methods_code_unique_idx" ON "payment_methods" USING btree ("code");--> statement-breakpoint
INSERT INTO "payment_methods" ("code", "kind", "title", "subtitle", "fee_bp", "enabled", "locked", "sort_order")
SELECT 'cod', 'cod', 'Cash on Delivery', 'Pay when your order arrives', 0, true, true, 0
WHERE NOT EXISTS (SELECT 1 FROM "payment_methods" WHERE "code" = 'cod');--> statement-breakpoint
INSERT INTO "payment_methods" ("code", "kind", "title", "subtitle", "fee_bp", "enabled", "locked", "sort_order")
SELECT 'mbank', 'mbank', 'Mobile banking', 'bKash · Nagad · Rocket',
	COALESCE((SELECT "mbank_fee_bp" FROM "platform_settings" ORDER BY "id" ASC LIMIT 1), 300), true, false, 1
WHERE NOT EXISTS (SELECT 1 FROM "payment_methods" WHERE "code" = 'mbank');--> statement-breakpoint
INSERT INTO "payment_methods" ("code", "kind", "title", "subtitle", "fee_bp", "enabled", "locked", "sort_order")
SELECT 'card', 'card', 'Card', 'Visa · Mastercard - via SSLCommerz',
	COALESCE((SELECT "card_fee_bp" FROM "platform_settings" ORDER BY "id" ASC LIMIT 1), 450), true, false, 2
WHERE NOT EXISTS (SELECT 1 FROM "payment_methods" WHERE "code" = 'card');
