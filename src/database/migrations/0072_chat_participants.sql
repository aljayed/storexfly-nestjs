-- Chat participants: the expand half of moving conversations off the fixed
-- (buyer, shop) pair and onto a pair of participants, so a thread can also be
-- account↔account or Hoomri Support↔anyone.
--
-- Expand only: nothing is dropped and no reader changes. Every existing thread
-- gains the two participant rows describing what it already was, so the old
-- columns and the new table agree while the services are migrated over.

CREATE TYPE "public"."chat_party_kind" AS ENUM('account', 'shop', 'support');--> statement-breakpoint

ALTER TABLE "chat_conversations" ADD COLUMN "pair_key" varchar(160);--> statement-breakpoint

CREATE TABLE "chat_participants" (
        "conversation_id" uuid NOT NULL,
        "side" varchar(1) NOT NULL,
        "kind" "chat_party_kind" NOT NULL,
        "account_id" uuid,
        "shop_id" uuid,
        "unread" integer DEFAULT 0 NOT NULL,
        "last_read_at" timestamp with time zone,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL,
        CONSTRAINT "chat_participants_conversation_id_chat_conversations_id_fk"
                FOREIGN KEY ("conversation_id") REFERENCES "public"."chat_conversations"("id") ON DELETE cascade,
        CONSTRAINT "chat_participants_account_id_users_id_fk"
                FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE cascade,
        CONSTRAINT "chat_participants_shop_id_shops_id_fk"
                FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade,
        CONSTRAINT "chat_participants_side_check" CHECK ("side" IN ('a', 'b')),
        -- Exactly the FK that matches the kind is set, so a participant can
        -- never be half-described or point at the wrong table.
        CONSTRAINT "chat_participants_kind_ref_check" CHECK (
                ("kind" = 'account' AND "account_id" IS NOT NULL AND "shop_id" IS NULL)
             OR ("kind" = 'shop'    AND "shop_id"    IS NOT NULL AND "account_id" IS NULL)
             OR ("kind" = 'support' AND "account_id" IS NULL AND "shop_id" IS NULL)
        )
);--> statement-breakpoint

CREATE UNIQUE INDEX "chat_participants_conversation_side_idx" ON "chat_participants" USING btree ("conversation_id","side");--> statement-breakpoint
CREATE INDEX "chat_participants_account_idx" ON "chat_participants" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "chat_participants_shop_idx" ON "chat_participants" USING btree ("shop_id");--> statement-breakpoint

-- Backfill: every thread today is account(buyer) ↔ shop. Side 'a' is the
-- account and side 'b' the shop, matching the sorted pair key below
-- ('account:…' sorts before 'shop:…', which is what keeps the key stable no
-- matter which side opened the thread).
INSERT INTO "chat_participants" ("conversation_id", "side", "kind", "account_id", "unread", "created_at")
SELECT "id", 'a', 'account', "buyer_id", "buyer_unread", "created_at" FROM "chat_conversations";--> statement-breakpoint

INSERT INTO "chat_participants" ("conversation_id", "side", "kind", "shop_id", "unread", "created_at")
SELECT "id", 'b', 'shop', "shop_id", "seller_unread", "created_at" FROM "chat_conversations";--> statement-breakpoint

UPDATE "chat_conversations"
SET "pair_key" = 'account:' || "buyer_id"::text || '|shop:' || "shop_id"::text;--> statement-breakpoint

-- One thread per pair. Partial so it can be created before every writer fills
-- the column; the contract half of this migration makes it NOT NULL.
CREATE UNIQUE INDEX "chat_conversations_pair_key_unique_idx" ON "chat_conversations" USING btree ("pair_key") WHERE "pair_key" IS NOT NULL;
