-- Contract half of the participants migration (see 0072).
--
-- Every thread now carries its two participants, so the buyer/shop columns
-- stop being the identity of a conversation and become what they always
-- described: the delete rules for a buyer↔shop thread. A support thread has no
-- buyer; a person-to-person thread has no shop.

ALTER TABLE "chat_conversations" ALTER COLUMN "buyer_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_conversations" ALTER COLUMN "shop_id" DROP NOT NULL;--> statement-breakpoint

-- Backfilled in 0072 and written by every path since, so this can be enforced.
ALTER TABLE "chat_conversations" ALTER COLUMN "pair_key" SET NOT NULL;--> statement-breakpoint

-- The pair is the identity now: one thread per pair, whichever side opened it.
DROP INDEX IF EXISTS "chat_conversations_pair_key_unique_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "chat_conversations_pair_key_unique_idx" ON "chat_conversations" USING btree ("pair_key");--> statement-breakpoint

-- The old identity, which cannot describe a thread without a shop.
DROP INDEX IF EXISTS "chat_conversations_buyer_shop_unique_idx";
