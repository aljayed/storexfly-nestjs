-- Unify buyer & seller into one account: the buyer profile now lives on `users`
-- (see 0050). Repoint the three FKs that referenced `buyers` at `users` (the
-- `buyer_id` column names are kept; only the target changes) and drop `buyers`.
-- Hand-written and idempotent. Databases are cleared for this cutover, so no
-- data merge is needed - the FK values are remapped by re-seeding, not here.

-- reviews.buyer_id → users.id (onDelete set null)
ALTER TABLE "reviews" DROP CONSTRAINT IF EXISTS "reviews_buyer_id_buyers_id_fk";--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "reviews" ADD CONSTRAINT "reviews_buyer_id_users_id_fk"
    FOREIGN KEY ("buyer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- buyer_notifications.buyer_id → users.id (onDelete cascade)
ALTER TABLE "buyer_notifications" DROP CONSTRAINT IF EXISTS "buyer_notifications_buyer_id_buyers_id_fk";--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "buyer_notifications" ADD CONSTRAINT "buyer_notifications_buyer_id_users_id_fk"
    FOREIGN KEY ("buyer_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- chat_conversations.buyer_id → users.id (onDelete cascade)
ALTER TABLE "chat_conversations" DROP CONSTRAINT IF EXISTS "chat_conversations_buyer_id_buyers_id_fk";--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_buyer_id_users_id_fk"
    FOREIGN KEY ("buyer_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DROP TABLE IF EXISTS "buyers";
