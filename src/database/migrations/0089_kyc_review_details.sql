ALTER TABLE "shops" ADD COLUMN "kyc_owner_legal_name" varchar(160);
--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "kyc_business_address" varchar(500);
--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "kyc_review_note" varchar(500);
