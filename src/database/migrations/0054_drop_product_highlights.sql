-- Drop the per-product "highlights" cards.
--
-- The product page carried two near-identical rows of icon + title + subtitle
-- cards: these per-product highlights, and the shop-wide strip below them.
-- The shop-wide strip stays and is now called "Highlights" in the console;
-- this column and its editor are gone.
--
-- Seller-authored content: 6 of 7 live products had highlights when this ran.
-- That text was exported to product-highlights-backup-20260729.json in the
-- project root before the column was dropped - restoring it means re-adding
-- the column and reloading from that file.
--
-- Hand-written and idempotent.

ALTER TABLE "products" DROP COLUMN IF EXISTS "highlights";
