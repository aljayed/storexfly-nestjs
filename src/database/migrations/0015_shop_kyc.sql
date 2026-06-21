DO $$ BEGIN
  CREATE TYPE "public"."kyc_status" AS ENUM('unsubmitted', 'pending', 'verified', 'rejected');
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "support_email" varchar(320);--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "support_phone" varchar(24);--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "kyc_status" "kyc_status" DEFAULT 'unsubmitted' NOT NULL;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "kyc_legal_name" varchar(200);--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "kyc_license_no" varchar(120);--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "kyc_document" text;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "kyc_submitted_at" timestamp with time zone;
