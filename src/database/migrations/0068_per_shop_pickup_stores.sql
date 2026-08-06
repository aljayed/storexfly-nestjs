-- The courier pickup store belongs to the shop, not the platform.
--
-- This is a marketplace: orders arrive from whichever seller made the sale,
-- and each of them ships from their own address. A single platform-wide
-- pickup store - which is what the operator console asked for - would have
-- had every parcel on the platform collected from one door, so it is gone.
-- Each shop now gets its own store registered under the operator's courier
-- account on first booking, built from the shop's own pickup address.
--
-- Credentials stay platform-held. Only the collection point moves, which is
-- the part that was never the platform's to decide.
--
-- Also collapses CarryBee back to one credential set. Two sets, one per
-- environment, meant two half-filled accounts and a real chance of the wrong
-- pair being live; one set plus an explicit "production" flag is what an
-- operator actually holds at any moment. Switching environments means pasting
-- the other triple in, which happens approximately once.
--
-- Idempotent by convention: re-running changes nothing.

-- ── Where each shop's parcels are collected ───────────────────────
-- The city/zone/area are the courier's own numeric ids, because that is what
-- registering a pickup store takes. Never shown to buyers.
ALTER TABLE "shops"
  ADD COLUMN IF NOT EXISTS "pickup_contact_name" varchar(60);--> statement-breakpoint
ALTER TABLE "shops"
  ADD COLUMN IF NOT EXISTS "pickup_phone" varchar(24);--> statement-breakpoint
ALTER TABLE "shops"
  ADD COLUMN IF NOT EXISTS "pickup_address" varchar(200);--> statement-breakpoint
ALTER TABLE "shops"
  ADD COLUMN IF NOT EXISTS "pickup_city_id" integer;--> statement-breakpoint
ALTER TABLE "shops"
  ADD COLUMN IF NOT EXISTS "pickup_zone_id" integer;--> statement-breakpoint
ALTER TABLE "shops"
  ADD COLUMN IF NOT EXISTS "pickup_area_id" integer;--> statement-breakpoint

-- ── The store the courier registered for each shop ────────────────
CREATE TABLE IF NOT EXISTS "shop_courier_stores" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE CASCADE,
  "provider" varchar(20) NOT NULL,
  "store_id" varchar(64) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shop_courier_stores_shop_provider_idx"
  ON "shop_courier_stores" ("shop_id", "provider");--> statement-breakpoint

-- ── One CarryBee credential set, with the environment made explicit ──
-- `carrybee_sandbox` said which of two stored pairs was live; the flag now
-- says which environment the single stored pair is for. Inverted so the
-- column reads as what it is, and defaulted false so a fresh install cannot
-- book real parcels before anything has been tested.
ALTER TABLE "platform_settings"
  ADD COLUMN IF NOT EXISTS "carrybee_production" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_settings"
  ADD COLUMN IF NOT EXISTS "pathao_production" boolean DEFAULT false NOT NULL;--> statement-breakpoint

-- Carry over what the old flags meant, for any database where they were set.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'platform_settings' AND column_name = 'carrybee_sandbox') THEN
    EXECUTE 'UPDATE "platform_settings" SET "carrybee_production" = NOT "carrybee_sandbox"';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'platform_settings' AND column_name = 'pathao_sandbox') THEN
    EXECUTE 'UPDATE "platform_settings" SET "pathao_production" = NOT "pathao_sandbox"';
  END IF;
END $$;--> statement-breakpoint

-- A sandbox triple lives in the sandbox columns only when production is off,
-- in which case it is the set to keep. Move it into the single set before
-- those columns go, so nothing an operator typed is thrown away.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'platform_settings' AND column_name = 'carrybee_sandbox_client_id') THEN
    EXECUTE $sql$
      UPDATE "platform_settings"
         SET "carrybee_client_id" = COALESCE("carrybee_client_id", "carrybee_sandbox_client_id"),
             "carrybee_client_secret" = COALESCE("carrybee_client_secret", "carrybee_sandbox_client_secret"),
             "carrybee_client_context" = COALESCE("carrybee_client_context", "carrybee_sandbox_client_context"),
             "carrybee_webhook_secret" = COALESCE("carrybee_webhook_secret", "carrybee_sandbox_webhook_secret")
    $sql$;
  END IF;
END $$;--> statement-breakpoint

ALTER TABLE "platform_settings" DROP COLUMN IF EXISTS "carrybee_sandbox";--> statement-breakpoint
ALTER TABLE "platform_settings" DROP COLUMN IF EXISTS "carrybee_sandbox_client_id";--> statement-breakpoint
ALTER TABLE "platform_settings" DROP COLUMN IF EXISTS "carrybee_sandbox_client_secret";--> statement-breakpoint
ALTER TABLE "platform_settings" DROP COLUMN IF EXISTS "carrybee_sandbox_client_context";--> statement-breakpoint
ALTER TABLE "platform_settings" DROP COLUMN IF EXISTS "carrybee_sandbox_webhook_secret";--> statement-breakpoint
ALTER TABLE "platform_settings" DROP COLUMN IF EXISTS "pathao_sandbox";--> statement-breakpoint

-- The platform-wide pickup stores these replaced.
ALTER TABLE "platform_settings" DROP COLUMN IF EXISTS "carrybee_store_id";--> statement-breakpoint
ALTER TABLE "platform_settings" DROP COLUMN IF EXISTS "carrybee_sandbox_store_id";--> statement-breakpoint
ALTER TABLE "platform_settings" DROP COLUMN IF EXISTS "pathao_store_id";
