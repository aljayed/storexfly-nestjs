DO $$ BEGIN
	CREATE TYPE "public"."notice_tone" AS ENUM('info', 'success', 'warning', 'danger');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid,
	"message" varchar(300) NOT NULL,
	"tone" "notice_tone" DEFAULT 'info' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN IF NOT EXISTS "mbank_fee_bp" integer DEFAULT 300 NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN IF NOT EXISTS "card_fee_bp" integer DEFAULT 450 NOT NULL;--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN IF NOT EXISTS "mbank_fee_bp" integer DEFAULT 300 NOT NULL;--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN IF NOT EXISTS "card_fee_bp" integer DEFAULT 450 NOT NULL;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "notices" ADD CONSTRAINT "notices_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notices_shop_idx" ON "notices" USING btree ("shop_id");