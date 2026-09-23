-- When a parcel reached the buyer. Payouts are scheduled on this now: an
-- order delivered before the 15th settles that month, and one delivered on
-- or after it waits for the next.
ALTER TABLE "orders" ADD COLUMN "delivered_at" timestamptz;
--> statement-breakpoint
-- Backfill what can be known. The courier's own stamp is the real thing;
-- where there is none, the last time the row changed is the closest an
-- already-delivered order can get, and it only has to be good enough to put
-- a past order in the right cycle.
UPDATE "orders"
SET "delivered_at" = COALESCE("courier_status_at", "updated_at")
WHERE "status" IN ('Delivered', 'Exchanged') AND "delivered_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "orders_delivered_at_idx" ON "orders" ("delivered_at");
