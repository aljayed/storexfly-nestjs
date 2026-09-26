-- Chat can carry a location: a one-off pin, or a live position the sender's
-- device keeps updating until the share ends.
--
-- ADD VALUE for the same reason as 0076: the enum sits on a hot table. The
-- value is unused until the first location message, so it is safe to apply
-- ahead of the code that writes it.
ALTER TYPE "public"."chat_message_type" ADD VALUE IF NOT EXISTS 'location';
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN IF NOT EXISTS "location" jsonb;
