DO $$ BEGIN
 CREATE TYPE "public"."shop_language" AS ENUM('en', 'bn');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "language" "shop_language" DEFAULT 'en' NOT NULL;
