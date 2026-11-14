-- The currency an account chose to read prices in. Null = follow the visitor's
-- country. Display only: orders are still charged in the shop's currency.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "preferred_currency" varchar(3);
--> statement-breakpoint
-- Last good exchange-rate snapshot, so a restart does not lose the rates.
CREATE TABLE IF NOT EXISTS "fx_rates" (
  "base" varchar(3) PRIMARY KEY NOT NULL,
  "rates" jsonb NOT NULL,
  "source" varchar(40) NOT NULL,
  "fetched_at" timestamp with time zone NOT NULL
);
