-- Payment links: a shop asks one buyer for an amount by URL.
--
-- The link itself is a small row - amount, what it is for, a public token.
-- Collecting goes through the same hosted-checkout sessions as everything
-- else, so `gateway_payments` learns a fourth purpose ('payment_link') and
-- which link a session is for, plus what the payer typed on the way in. That
-- lives on the session rather than the link because a link can be attempted
-- more than once, and only the attempt that actually paid should say who paid.
--
-- Idempotent by convention: re-running changes nothing.

CREATE TABLE IF NOT EXISTS "payment_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "shop_id" uuid NOT NULL,
  "token" varchar(24) NOT NULL,
  "title" varchar(120) NOT NULL,
  "description" varchar(500),
  "amount_cents" integer NOT NULL,
  "status" varchar(16) DEFAULT 'active' NOT NULL,
  "expires_at" timestamp with time zone,
  "paid_at" timestamp with time zone,
  "trx_id" varchar(80),
  "payment_method" varchar(40),
  "instrument" varchar(60),
  "payer_name" varchar(100),
  "payer_phone" varchar(24),
  "payer_email" varchar(320),
  "payer_note" varchar(300),
  "refunded_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_shop_id_shops_id_fk"
    FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_links_token_unique_idx" ON "payment_links" ("token");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_links_shop_idx" ON "payment_links" ("shop_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_links_paid_idx" ON "payment_links" ("shop_id","paid_at");
--> statement-breakpoint
ALTER TABLE "gateway_payments" ADD COLUMN IF NOT EXISTS "payment_link_id" uuid;
--> statement-breakpoint
ALTER TABLE "gateway_payments" ADD COLUMN IF NOT EXISTS "payer_details" jsonb;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "gateway_payments" ADD CONSTRAINT "gateway_payments_payment_link_id_payment_links_id_fk"
    FOREIGN KEY ("payment_link_id") REFERENCES "public"."payment_links"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gateway_payments_link_idx" ON "gateway_payments" ("payment_link_id");
