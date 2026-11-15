-- CarryBee is the only supported courier. Do not switch a stored account on
-- automatically or rewrite historical order/settlement consignments.
-- Release the requirement if removing the old courier would leave no usable one.
UPDATE "platform_settings"
SET "courier_required" = false
WHERE "courier_required" = true AND NOT (
  "carrybee_enabled" = true
  AND NULLIF(BTRIM("carrybee_client_id"), '') IS NOT NULL
  AND NULLIF(BTRIM("carrybee_client_secret"), '') IS NOT NULL
  AND NULLIF(BTRIM("carrybee_client_context"), '') IS NOT NULL
);--> statement-breakpoint
ALTER TABLE "platform_settings"
  DROP COLUMN IF EXISTS "steadfast_enabled",
  DROP COLUMN IF EXISTS "steadfast_api_key",
  DROP COLUMN IF EXISTS "steadfast_secret_key",
  DROP COLUMN IF EXISTS "pathao_enabled",
  DROP COLUMN IF EXISTS "pathao_production",
  DROP COLUMN IF EXISTS "pathao_client_id",
  DROP COLUMN IF EXISTS "pathao_client_secret",
  DROP COLUMN IF EXISTS "pathao_username",
  DROP COLUMN IF EXISTS "pathao_password";--> statement-breakpoint
DELETE FROM "shop_courier_stores" WHERE "provider" <> 'carrybee';--> statement-breakpoint
-- Per-shop credentials have been unused since platform-held courier accounts.
DROP TABLE IF EXISTS "shop_couriers";
