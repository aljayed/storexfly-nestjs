-- Quick replies: defaults become deletable. Removing a default hides the row
-- instead of deleting it, so list() still sees the shop as seeded and never
-- re-inserts the starter set. Idempotent by convention (see 0015).
ALTER TABLE "chat_quick_replies" ADD COLUMN IF NOT EXISTS "hidden" boolean DEFAULT false NOT NULL;
