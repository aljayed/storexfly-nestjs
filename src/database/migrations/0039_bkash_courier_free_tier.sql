-- Payment truth, bKash gateway, Steadfast courier, free tier, buyer notifications.
-- Idempotent: every statement is safe to re-run.

-- New payment states: 'Due' (money not yet in hand) and 'Pending' (gateway in flight).
ALTER TYPE "payment_status" ADD VALUE IF NOT EXISTS 'Due';--> statement-breakpoint
ALTER TYPE "payment_status" ADD VALUE IF NOT EXISTS 'Pending';--> statement-breakpoint

-- Shop pricing tier.
DO $$ BEGIN
  CREATE TYPE "shop_plan" AS ENUM ('free', 'paid');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- Which gateway collects a checkout method's money.
DO $$ BEGIN
  CREATE TYPE "payment_gateway" AS ENUM ('none', 'bkash');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- Existing shops predate the free tier and stay 'paid'.
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "plan" "shop_plan" DEFAULT 'paid' NOT NULL;--> statement-breakpoint

ALTER TABLE "payment_methods" ADD COLUMN IF NOT EXISTS "gateway" "payment_gateway" DEFAULT 'none' NOT NULL;--> statement-breakpoint

ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "delivery_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "courier_consignment_id" varchar(40);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "courier_tracking_code" varchar(40);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "courier_status" varchar(40);--> statement-breakpoint

-- Gateway + courier credentials on the platform-settings singleton.
ALTER TABLE "platform_settings" ADD COLUMN IF NOT EXISTS "bkash_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN IF NOT EXISTS "bkash_sandbox" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN IF NOT EXISTS "bkash_app_key" text;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN IF NOT EXISTS "bkash_app_secret" text;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN IF NOT EXISTS "bkash_username" text;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN IF NOT EXISTS "bkash_password" text;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN IF NOT EXISTS "steadfast_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN IF NOT EXISTS "steadfast_api_key" text;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN IF NOT EXISTS "steadfast_secret_key" text;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "gateway_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"provider" varchar(20) DEFAULT 'bkash' NOT NULL,
	"payment_id" varchar(80) NOT NULL,
	"status" varchar(20) DEFAULT 'created' NOT NULL,
	"amount_cents" integer NOT NULL,
	"trx_id" varchar(80),
	"payer_reference" varchar(40),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "gateway_payments" ADD CONSTRAINT "gateway_payments_order_id_orders_id_fk"
    FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gateway_payments_order_idx" ON "gateway_payments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gateway_payments_payment_idx" ON "gateway_payments" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gateway_payments_status_idx" ON "gateway_payments" USING btree ("status","created_at");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "buyer_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"buyer_id" uuid NOT NULL,
	"order_id" uuid,
	"shop_id" uuid,
	"type" varchar(30) NOT NULL,
	"title" varchar(160) NOT NULL,
	"body" text NOT NULL,
	"order_reference" varchar(16),
	"shop_name" varchar(160),
	"shop_handle" varchar(80),
	"read" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "buyer_notifications" ADD CONSTRAINT "buyer_notifications_buyer_id_buyers_id_fk"
    FOREIGN KEY ("buyer_id") REFERENCES "public"."buyers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "buyer_notifications" ADD CONSTRAINT "buyer_notifications_order_id_orders_id_fk"
    FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "buyer_notifications" ADD CONSTRAINT "buyer_notifications_shop_id_shops_id_fk"
    FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "buyer_notifications_buyer_idx" ON "buyer_notifications" USING btree ("buyer_id","read","created_at");
