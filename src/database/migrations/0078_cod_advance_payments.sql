ALTER TABLE "shops" ADD COLUMN "cod_advance_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "advance_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "advance_paid_at" timestamp with time zone;
