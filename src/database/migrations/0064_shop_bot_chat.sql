-- Per-shop switch for the AI auto-reply in the seller inbox.
--
-- Off by default, and deliberately so: the agent answers as the shop's own
-- staff, so turning it on for an existing seller without them asking would put
-- words in their mouth in front of their own customers.
--
-- The chat itself is unaffected either way - this only decides whether an
-- incoming customer message gets an automatic first answer while the seller is
-- away. Escalation still hands the thread back to the human.
--
-- Idempotent by convention: re-running changes nothing.

ALTER TABLE "shops"
  ADD COLUMN IF NOT EXISTS "bot_chat_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint

-- Same normalisation guard the other hand-written migrations use: if the
-- column already exists from an earlier experiment, ADD COLUMN IF NOT EXISTS
-- above did nothing, so make sure it carries the default and the NOT NULL the
-- code relies on.
UPDATE "shops" SET "bot_chat_enabled" = false WHERE "bot_chat_enabled" IS NULL;--> statement-breakpoint
ALTER TABLE "shops" ALTER COLUMN "bot_chat_enabled" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "shops" ALTER COLUMN "bot_chat_enabled" SET NOT NULL;
