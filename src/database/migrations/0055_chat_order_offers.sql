-- Order offers in chat: a seller proposes items at a price they set, and the
-- buyer accepting the card places the order.
--
-- The offer is its own table, not just a card payload, because it gates money:
-- it is the single authority for what was offered and whether it has been
-- used. Acceptance flips `status` under a row lock, so a double-tap or two
-- devices can only ever produce one order.
--
-- Hand-written and idempotent.

ALTER TYPE "public"."chat_message_type" ADD VALUE IF NOT EXISTS 'offer';--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "public"."chat_offer_status" AS ENUM('pending', 'accepted', 'rejected', 'withdrawn', 'expired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

ALTER TABLE "chat_messages" ADD COLUMN IF NOT EXISTS "offer" jsonb;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "chat_order_offers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "conversation_id" uuid NOT NULL REFERENCES "chat_conversations"("id") ON DELETE cascade,
  "shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE cascade,
  "buyer_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "items" jsonb NOT NULL,
  "items_subtotal_cents" integer NOT NULL,
  "delivery_cents" integer DEFAULT 0 NOT NULL,
  "total_cents" integer NOT NULL,
  "note" varchar(300),
  "status" "chat_offer_status" DEFAULT 'pending' NOT NULL,
  "order_id" uuid,
  "expires_at" timestamp with time zone,
  "responded_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "chat_order_offers_conversation_idx"
  ON "chat_order_offers" ("conversation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_order_offers_shop_idx"
  ON "chat_order_offers" ("shop_id");
