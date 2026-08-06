-- Write every courier callback down before acting on it, and hold a webhook
-- secret per CarryBee environment.
--
-- Two things the integration screen makes plain that the first pass assumed:
--
--   * The handshake is an ordinary event - `{"event":"webhook.integration"}` -
--     not an empty body, so it needs recognising by name.
--   * The webhook is registered per environment (its "Try Sandbox" toggle),
--     each registration carrying its own secret. One stored secret would mean
--     whichever environment was configured second silently failed the check.
--     A callback carries no environment marker, so the route accepts either.
--
-- And the log: the courier decides whether an order shipped, was delivered,
-- and whether its COD cash came in. A dropped callback is money, and handling
-- one inline left no record of what was missed or any way to replay it. A row
-- per callback gives durability, an audit trail against the courier, and a
-- retry the sweep can drive.
--
-- Deliberately a table rather than a broker: a parcel emits a dozen events
-- over its life, which Postgres handles without another moving part to run.
--
-- Idempotent by convention: re-running changes nothing.

ALTER TABLE "platform_settings"
  ADD COLUMN IF NOT EXISTS "carrybee_sandbox_webhook_secret" text;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "courier_webhook_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "provider" varchar(20) DEFAULT 'carrybee' NOT NULL,
  "event" varchar(60) NOT NULL,
  "consignment_id" varchar(64),
  "merchant_order_id" varchar(64),
  -- SET NULL rather than CASCADE: the callback is evidence of what the courier
  -- reported and outlives the order row it happened to be about.
  "order_id" uuid REFERENCES "orders"("id") ON DELETE SET NULL,
  "payload" jsonb NOT NULL,
  "event_at" timestamp with time zone,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  "processed_at" timestamp with time zone,
  "attempts" integer DEFAULT 0 NOT NULL,
  "last_error" text
);--> statement-breakpoint

-- The sweep's working set: what is still owed, oldest first.
CREATE INDEX IF NOT EXISTS "courier_webhook_pending_idx"
  ON "courier_webhook_events" ("processed_at", "received_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "courier_webhook_consignment_idx"
  ON "courier_webhook_events" ("consignment_id");
