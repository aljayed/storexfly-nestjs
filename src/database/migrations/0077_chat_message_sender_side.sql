-- A role is not a stable chat identity: a shop owner can read the same thread
-- from an account session and a console session. Persist the participant slot
-- that actually authored each message so bubbles, receipts and delivery state
-- remain correct from either surface.

ALTER TABLE "chat_messages" ADD COLUMN "sender_side" varchar(1);--> statement-breakpoint

UPDATE "chat_messages" AS m
SET "sender_side" = COALESCE(
  -- Account-authored messages carry the account id even if they were sent
  -- through an owner's seller-console seat. This also distinguishes the two
  -- sides of an account↔account thread, where both legacy roles are customer.
  (
    SELECT p."side"
    FROM "chat_participants" p
    WHERE p."conversation_id" = m."conversation_id"
      AND p."kind" = 'account'
      AND p."account_id" = m."sender_id"
    LIMIT 1
  ),
  (
    SELECT p."side"
    FROM "chat_participants" p
    WHERE p."conversation_id" = m."conversation_id"
      AND (
        -- Compared as text on purpose: 'support' is added to the enum by
        -- 0076, and Postgres refuses to *use* a value added by ALTER TYPE in
        -- the same transaction. On a fresh database both migrations run in
        -- one, so referencing the enum literal here fails with
        -- "unsafe use of new value". The cast is not subject to that check.
        (m."sender_role"::text = 'support' AND p."kind" = 'support')
        OR (m."sender_role"::text = 'customer' AND p."kind" = 'account')
        OR (m."sender_role"::text = 'seller' AND p."kind" = 'shop')
      )
    ORDER BY p."side"
    LIMIT 1
  ),
  (
    SELECT p."side"
    FROM "chat_participants" p
    WHERE p."conversation_id" = m."conversation_id"
      AND p."kind" <> 'support'
    ORDER BY p."side" DESC
    LIMIT 1
  )
);--> statement-breakpoint

ALTER TABLE "chat_messages" ALTER COLUMN "sender_side" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_sender_side_check" CHECK ("sender_side" IN ('a', 'b'));--> statement-breakpoint
CREATE INDEX "chat_messages_sender_sent_idx" ON "chat_messages" USING btree ("sender_id", "sent_at");--> statement-breakpoint

-- REST retries and double taps must reconcile to the same message rather than
-- incrementing unread twice. System/bot messages leave this null; PostgreSQL
-- permits multiple nulls in a unique index.
ALTER TABLE "chat_messages" ADD COLUMN "client_ref" varchar(64);--> statement-breakpoint
CREATE UNIQUE INDEX "chat_messages_sender_client_ref_idx" ON "chat_messages" USING btree ("sender_id", "client_ref");--> statement-breakpoint

-- Participant FKs cascade the participant row when an account/shop is
-- deleted. Generalized threads do not always have a legacy buyer_id/shop_id
-- FK, so remove the parent conversation as well instead of leaving an orphan
-- visible to the other side.
CREATE OR REPLACE FUNCTION "chat_delete_conversation_with_participant"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM "chat_conversations" WHERE "id" = OLD."conversation_id";
  RETURN OLD;
END;
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS "chat_participant_delete_conversation" ON "chat_participants";--> statement-breakpoint
CREATE TRIGGER "chat_participant_delete_conversation"
AFTER DELETE ON "chat_participants"
FOR EACH ROW EXECUTE FUNCTION "chat_delete_conversation_with_participant"();
