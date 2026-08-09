-- Operator suspension of a shop, from the platform console's shop drawer.
--
-- A separate column from `shops.live` on purpose. `live` belongs to the
-- seller - they flip it from their own console, and the billing engine pauses
-- and un-pauses shops through it - so a suspension parked there would be
-- undone by the next "go live" click or the next successful payment. This
-- column can only be cleared by the platform console.
--
-- Suspending also forces `live` false, which is what keeps the change small:
-- every buyer-facing route already refuses a shop that is not live, so the
-- storefront, catalog, checkout, discover feed and sitemap need no new checks.
-- The lock itself is what `setShopLive` and the billing engine's `liftPause`
-- now consult before turning a shop back on.
--
-- The reason travels with it so the seller is told why, as a targeted notice.
--
-- Idempotent by convention: re-running changes nothing.

ALTER TABLE "shops"
  ADD COLUMN IF NOT EXISTS "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shops"
  ADD COLUMN IF NOT EXISTS "suspended_reason" varchar(300);
