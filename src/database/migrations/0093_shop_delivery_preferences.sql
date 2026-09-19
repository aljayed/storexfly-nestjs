ALTER TABLE "shops" ADD COLUMN "delivery_mode" varchar(16) CHECK (delivery_mode IN ('manual', 'carrybee'));
--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "pickup_district" varchar(80);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "delivery_mode" varchar(16) CHECK (delivery_mode IN ('manual', 'carrybee'));
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "courier_booking_state" varchar(16) CHECK (courier_booking_state IN ('creating', 'uncertain'));
