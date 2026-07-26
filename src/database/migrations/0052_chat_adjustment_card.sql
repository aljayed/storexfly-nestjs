-- Chat "adjustment" card: shop-initiated order-amount changes appear in the
-- buyer↔shop thread. A decrease is auto-applied + informational; an increase is
-- an approval card the buyer acts on in-chat. Adds the enum value + payload
-- column. Hand-written and idempotent.

ALTER TYPE "public"."chat_message_type" ADD VALUE IF NOT EXISTS 'adjustment';--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN IF NOT EXISTS "adjustment" jsonb;
