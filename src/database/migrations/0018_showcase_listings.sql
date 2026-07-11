DO $$ BEGIN
  CREATE TYPE "public"."listing_type" AS ENUM('sale', 'showcase');
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "listing_type" "listing_type" DEFAULT 'sale' NOT NULL;
