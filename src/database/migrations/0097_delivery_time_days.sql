-- How long a shop takes to deliver, and the per-item exception to it.
--
-- Shops get the platform window (5 days inside Dhaka, 10 outside) rather than
-- NULL: the site already states that window publicly for the payment gateway,
-- so every existing shop is already making that promise and the backfill only
-- writes down what is true.
--
-- Products stay NULL, which means "however long this shop takes". Only an
-- item that is genuinely slower or faster than its shop's catalogue gets a
-- number of its own.
ALTER TABLE "shops" ADD COLUMN "delivery_inside_days" integer DEFAULT 5 NOT NULL;
--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "delivery_outside_days" integer DEFAULT 10 NOT NULL;
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "delivery_inside_days" integer;
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "delivery_outside_days" integer;
