-- Sellers reach buyers by phone, so the admin customer list needs it without
-- joining orders. Hand-written and idempotent (see 0025 for why we avoid
-- `drizzle-kit generate` here). Backfilled from each customer's most recent
-- order that carried a phone.
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "phone" varchar(24) DEFAULT '' NOT NULL;
--> statement-breakpoint
UPDATE "customers" c
SET "phone" = o."phone"
FROM (
  SELECT DISTINCT ON ("customer_id") "customer_id", "phone"
  FROM "orders"
  WHERE "customer_id" IS NOT NULL AND "phone" IS NOT NULL AND "phone" <> ''
  ORDER BY "customer_id", "placed_at" DESC
) o
WHERE c."id" = o."customer_id" AND c."phone" = '';
