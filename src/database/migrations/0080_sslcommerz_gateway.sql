-- SSLCommerz joins bKash as a checkout gateway the platform collects through.
--
-- Why a second one: bKash's hosted checkout only covers bKash. SSLCommerz is
-- an aggregator - one hosted page fronts Visa/Mastercard, net banking and
-- every MFS wallet - so it is what the 'card' checkout kind has always been
-- described as running on, and it is the other route offered for the 15% COD
-- advance. Credentials are platform-held (one store account serves every
-- shop), set from the operator console, and the store password never leaves
-- the API in readable form.
--
-- Idempotent by convention: re-running changes nothing.

-- Append-only in Postgres, so the new gateway sits after the existing values.
ALTER TYPE "public"."payment_gateway" ADD VALUE IF NOT EXISTS 'sslcommerz';--> statement-breakpoint

ALTER TABLE "platform_settings"
  ADD COLUMN IF NOT EXISTS "sslcommerz_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Default on: a fresh install should reach the sandbox, never live money.
ALTER TABLE "platform_settings"
  ADD COLUMN IF NOT EXISTS "sslcommerz_sandbox" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_settings"
  ADD COLUMN IF NOT EXISTS "sslcommerz_store_id" text;--> statement-breakpoint
ALTER TABLE "platform_settings"
  ADD COLUMN IF NOT EXISTS "sslcommerz_store_password" text;
