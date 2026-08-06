-- Keep both CarryBee credential sets, not one plus an environment flag.
--
-- CarryBee issues a separate Client ID / Secret / Context triple per
-- environment and both stay valid indefinitely - the API Credentials screen
-- lists them side by side. Storing a single set meant `carrybee_sandbox` was
-- doing two jobs at once: choosing the host *and* implying which credentials
-- were in the columns. Testing in sandbox and then going live would leave the
-- sandbox triple pointed at developers.carrybee.com, where it fails auth - and
-- with `courier_required` on, that is every shop unable to ship until three
-- values are retyped from memory.
--
-- Now the flag only selects which stored pair is live. Pickup stores are
-- registered per environment too, so the store id follows the credentials.
--
-- Idempotent by convention: re-running changes nothing.

ALTER TABLE "platform_settings"
  ADD COLUMN IF NOT EXISTS "carrybee_sandbox_client_id" text;--> statement-breakpoint
ALTER TABLE "platform_settings"
  ADD COLUMN IF NOT EXISTS "carrybee_sandbox_client_secret" text;--> statement-breakpoint
ALTER TABLE "platform_settings"
  ADD COLUMN IF NOT EXISTS "carrybee_sandbox_client_context" text;--> statement-breakpoint
ALTER TABLE "platform_settings"
  ADD COLUMN IF NOT EXISTS "carrybee_sandbox_store_id" varchar(64);--> statement-breakpoint

-- Anything already entered went in while the sandbox flag was on by default,
-- so it is sandbox credentials sitting in what are now the production columns.
-- Move it across rather than leaving it to fail against the live host. Guarded
-- so a re-run - or a database where production credentials have since been
-- entered properly - is left alone.
UPDATE "platform_settings"
   SET "carrybee_sandbox_client_id" = "carrybee_client_id",
       "carrybee_sandbox_client_secret" = "carrybee_client_secret",
       "carrybee_sandbox_client_context" = "carrybee_client_context",
       "carrybee_sandbox_store_id" = "carrybee_store_id",
       "carrybee_client_id" = NULL,
       "carrybee_client_secret" = NULL,
       "carrybee_client_context" = NULL,
       "carrybee_store_id" = NULL
 WHERE "carrybee_sandbox" = true
   AND "carrybee_client_id" IS NOT NULL
   AND "carrybee_sandbox_client_id" IS NULL;
