-- Per-option variant photos and stock.
--
-- The option shape itself lives in `products.variant_groups` (jsonb), so the
-- new `image` / `stock` keys need no DDL — absent keys simply read as
-- "no picture" and "not tracked" on existing rows.
--
-- What does need a column is the order side: cancelling an order restocks
-- what it took, and per-option stock can only be handed back if the line
-- remembers which option ids were bought. `variant` is a display string, so
-- the ids get their own jsonb column. Null on every historical row, which the
-- restock path reads as "product-level stock only" — exactly the old
-- behaviour.
--
-- Hand-written and idempotent.

ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "variant_pick" jsonb;
