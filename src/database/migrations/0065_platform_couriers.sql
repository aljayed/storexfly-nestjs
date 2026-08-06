-- Couriers move from per-shop merchant accounts to one platform-held account,
-- and the order pipeline hands control to that courier the moment the parcel
-- leaves the seller's hands.
--
-- Why: a shop booking parcels on its own courier account owns the entire
-- fulfilment record. It could cancel every order in the console - which is
-- what the sales meter reads - carry the customer over to WhatsApp, and still
-- deliver and get paid, so nothing the platform bills on ever moved. The
-- courier is the one party in the flow a shop cannot edit, so bookings now run
-- on the operator's own credentials and the consignment becomes the source of
-- truth for Shipped/Delivered.
--
-- The new 'HandedOver' status is the hinge: New → Confirmed → Packed →
-- HandedOver is the seller's to drive, everything past it arrives from the
-- courier's webhook.
--
-- Idempotent by convention: re-running changes nothing.

-- ── The pipeline gains a handover step ────────────────────────────
-- Append-only in Postgres, so it sits after the existing values; the logical
-- order lives in STATUS_FLOW, not in the enum.
ALTER TYPE "public"."order_status" ADD VALUE IF NOT EXISTS 'HandedOver';--> statement-breakpoint

-- ── Platform courier credentials ──────────────────────────────────
-- CarryBee (developers.carrybee.com) is the primary carrier; Steadfast and
-- Pathao stay available as fallbacks. At most one is enabled at a time - the
-- settings service clears the others on enable. The Steadfast columns already
-- exist from before couriers went per-shop and are simply read again.
ALTER TABLE "platform_settings"
  ADD COLUMN IF NOT EXISTS "carrybee_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_settings"
  ADD COLUMN IF NOT EXISTS "carrybee_sandbox" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_settings"
  ADD COLUMN IF NOT EXISTS "carrybee_client_id" text;--> statement-breakpoint
ALTER TABLE "platform_settings"
  ADD COLUMN IF NOT EXISTS "carrybee_client_secret" text;--> statement-breakpoint
ALTER TABLE "platform_settings"
  ADD COLUMN IF NOT EXISTS "carrybee_client_context" text;--> statement-breakpoint
ALTER TABLE "platform_settings"
  ADD COLUMN IF NOT EXISTS "carrybee_store_id" varchar(64);--> statement-breakpoint
ALTER TABLE "platform_settings"
  ADD COLUMN IF NOT EXISTS "carrybee_webhook_secret" text;--> statement-breakpoint

ALTER TABLE "platform_settings"
  ADD COLUMN IF NOT EXISTS "pathao_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_settings"
  ADD COLUMN IF NOT EXISTS "pathao_sandbox" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_settings"
  ADD COLUMN IF NOT EXISTS "pathao_client_id" text;--> statement-breakpoint
ALTER TABLE "platform_settings"
  ADD COLUMN IF NOT EXISTS "pathao_client_secret" text;--> statement-breakpoint
ALTER TABLE "platform_settings"
  ADD COLUMN IF NOT EXISTS "pathao_username" text;--> statement-breakpoint
ALTER TABLE "platform_settings"
  ADD COLUMN IF NOT EXISTS "pathao_password" text;--> statement-breakpoint
ALTER TABLE "platform_settings"
  ADD COLUMN IF NOT EXISTS "pathao_store_id" varchar(40);--> statement-breakpoint

-- Off by default: switching the platform courier on must not strand shops that
-- are mid-fulfilment with parcels already out on their own carrier. The
-- operator turns it on once sellers have been moved over, and from then on a
-- shop can only ship through the platform courier.
ALTER TABLE "platform_settings"
  ADD COLUMN IF NOT EXISTS "courier_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint

-- The Steadfast columns predate this migration but were nullable-by-accident
-- on some databases; normalise so the settings service can rely on them.
UPDATE "platform_settings" SET "steadfast_enabled" = false WHERE "steadfast_enabled" IS NULL;--> statement-breakpoint
ALTER TABLE "platform_settings" ALTER COLUMN "steadfast_enabled" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "platform_settings" ALTER COLUMN "steadfast_enabled" SET NOT NULL;--> statement-breakpoint

-- ── Orders carry the consignment's own record ─────────────────────
-- CarryBee consignment IDs are longer than the 40 chars Steadfast needed.
ALTER TABLE "orders" ALTER COLUMN "courier_consignment_id" TYPE varchar(64);--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "courier_tracking_code" TYPE varchar(64);--> statement-breakpoint

-- Webhooks can arrive out of order, so each stored status carries the time the
-- courier stamped it and an older event is dropped instead of rolling the
-- order backwards.
ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "courier_status_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "courier_delivery_fee_cents" integer;--> statement-breakpoint
ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "courier_cod_fee_cents" integer;--> statement-breakpoint
-- What the courier actually took at the door - less than the order total on a
-- partial delivery, which is the figure a COD settlement should trust.
ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "courier_collected_cents" integer;--> statement-breakpoint
ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "courier_failure_reason" varchar(255);--> statement-breakpoint
ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "handed_over_at" timestamp with time zone;--> statement-breakpoint

-- Webhook lookups arrive keyed by consignment id with no shop context.
CREATE INDEX IF NOT EXISTS "orders_courier_consignment_idx"
  ON "orders" ("courier_consignment_id");--> statement-breakpoint

-- ── shop_couriers is left in place ────────────────────────────────
-- Deliberately not dropped: it still holds credentials sellers entered by
-- hand, and destroying that is not something a schema migration should do.
-- Nothing reads or writes it any more (see shop-couriers.schema.ts).
