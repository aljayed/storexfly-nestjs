-- Per-shop courier credentials (Steadfast + Pathao), managed by sellers from
-- the console. Platform-level Steadfast settings are no longer read.
-- Idempotent: every statement is safe to re-run.

CREATE TABLE IF NOT EXISTS "shop_couriers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"provider" varchar(20) NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"api_key" text,
	"secret_key" text,
	"client_id" text,
	"client_secret" text,
	"username" text,
	"password" text,
	"store_id" varchar(40),
	"sandbox" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "shop_couriers" ADD CONSTRAINT "shop_couriers_shop_id_shops_id_fk"
    FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shop_couriers_shop_provider_unique_idx"
  ON "shop_couriers" USING btree ("shop_id","provider");--> statement-breakpoint

-- Which provider booked the consignment; null legacy rows were Steadfast.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "courier_provider" varchar(20);
