-- A shop opened on a temporary link.
--
-- A payment can land after the hour a shop's name was held for, and by then
-- somebody else may have taken the name. The seller has paid, so the shop
-- still opens - on a link made from their account ID (shop-<public id>) -
-- and handle_pending tells the console to ask them for a real one. Choosing
-- it clears the flag, and from then on the link is as fixed as any other.
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "handle_pending" boolean DEFAULT false NOT NULL;
