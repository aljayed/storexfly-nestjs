-- shops.currency exists in the Drizzle schema (and every query built from
-- it) but was never captured in a migration - added via `db:push` in dev at
-- some point and the snapshot history came to believe it was already
-- migrated, so `drizzle-kit generate` sees no diff. Hand-written to close
-- the gap; idempotent so it's safe on databases that already have it via push.
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "currency" varchar(3) DEFAULT 'BDT' NOT NULL;
