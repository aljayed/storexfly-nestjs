-- Buyer-approved order amount changes. A seller proposes a new order total with
-- a reason (customization/add-on); the buyer approves it (rewrites the order's
-- total) or declines. Rows are kept forever as the order's amount history.
-- Hand-written and idempotent (see 0030/0031/0045 for why we avoid
-- `drizzle-kit generate` here) — every statement is safe to re-run.

CREATE TABLE IF NOT EXISTS "order_amount_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"previous_total_cents" integer NOT NULL,
	"new_total_cents" integer NOT NULL,
	"reason" varchar(300) NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "order_amount_adjustments" ADD CONSTRAINT "order_amount_adjustments_order_id_orders_id_fk"
    FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "order_amount_adjustments" ADD CONSTRAINT "order_amount_adjustments_shop_id_shops_id_fk"
    FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_amount_adjustments_order_idx"
  ON "order_amount_adjustments" USING btree ("order_id","created_at");
