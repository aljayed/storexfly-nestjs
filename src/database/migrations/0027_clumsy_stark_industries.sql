CREATE TABLE IF NOT EXISTS "settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"period" varchar(7) NOT NULL,
	"orders_count" integer NOT NULL,
	"total_cents" integer NOT NULL,
	"cod_cents" integer NOT NULL,
	"mbank_cents" integer NOT NULL,
	"card_cents" integer NOT NULL,
	"other_cents" integer NOT NULL,
	"fee_cents" integer NOT NULL,
	"payout_cents" integer NOT NULL,
	"note" varchar(200),
	"paid_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "settlements" ADD CONSTRAINT "settlements_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "settlements_shop_period_unique_idx" ON "settlements" USING btree ("shop_id","period");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "settlements_period_idx" ON "settlements" USING btree ("period");