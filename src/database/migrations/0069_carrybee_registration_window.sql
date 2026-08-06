-- A deliberate, self-closing window for registering the CarryBee webhook.
--
-- CarryBee's verification POST does not carry
-- X-CB-Webhook-Integration-Header, whatever their documentation says - it only
-- checks that our *reply* carries it, with the exact secret. Confirmed from
-- production logs: their attempts are rejected with "secret header absent"
-- while an otherwise identical request carrying the header answers 202.
--
-- So registering means handing the secret to a caller who has proved nothing.
-- Leaving that open permanently would make the secret public to anyone who
-- knows the URL, and with it the ability to forge delivery events - marking
-- orders delivered collects their COD, marking them returned cancels and
-- restocks. Both are money.
--
-- Instead the operator opens a short window, presses "Add Webhook", and the
-- window shuts on its own. Real events still require the header, always.
--
-- Idempotent by convention: re-running changes nothing.

ALTER TABLE "platform_settings"
  ADD COLUMN IF NOT EXISTS "carrybee_webhook_registration_until" timestamp with time zone;
