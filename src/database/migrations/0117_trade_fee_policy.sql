-- Trade shops have no platform sales commission. Processing applies only
-- to gateway receipts; the wholesaler carries it and reseller margins are free.
ALTER TABLE "orders" ALTER COLUMN "platform_fee_bp" SET DEFAULT 0;
--> statement-breakpoint
UPDATE "orders" AS o SET "platform_fee_bp" = 0
FROM "shops" AS s
WHERE o."shop_id" = s."id" AND s."business_type" IN ('wholesale', 'reseller');
--> statement-breakpoint
UPDATE "payment_methods" SET "fee_bp" = CASE WHEN "gateway" = 'none' THEN 0 ELSE 450 END;
--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN IF NOT EXISTS "reseller_margin_cents" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN IF NOT EXISTS "paid_with_period" varchar(7);
--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN IF NOT EXISTS "processing_shortfall_cents" integer NOT NULL DEFAULT 0;
