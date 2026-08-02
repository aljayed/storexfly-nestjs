-- Record the physical units an order line consumed.
--
-- `order_items.qty` counts *picks*: a "Pack of 3" line with qty 2 is two
-- picks but six units, and checkout decremented six. Cancelling the order
-- restocked `qty` - so packs came back short, and with per-option variant
-- counters that same skew would now hit those too.
--
-- The fix needs the unit count on the line, since packs can be edited or
-- deleted after the order. Null on every historical row, which the restock
-- path reads as "fall back to qty" - the exact behaviour those orders were
-- placed under, so nothing is retroactively rewritten.
--
-- Hand-written and idempotent.

ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "units" integer;
