ALTER TABLE "buyers" ADD COLUMN "phone" varchar(24);--> statement-breakpoint
ALTER TABLE "buyers" ADD COLUMN "address_line" text;--> statement-breakpoint
ALTER TABLE "buyers" ADD COLUMN "address_city" varchar(120);--> statement-breakpoint
ALTER TABLE "buyers" ADD COLUMN "address_pincode" varchar(24);