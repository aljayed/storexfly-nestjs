-- Unify buyer & seller into one account: fold the storefront-shopper profile
-- fields onto `users` (the single human account). `buyers` is dropped in 0051.
-- Hand-written and idempotent.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "phone_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "address_line" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "address_city" varchar(120);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "address_pincode" varchar(24);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "geo" jsonb;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "last_pay_method" varchar(64);
