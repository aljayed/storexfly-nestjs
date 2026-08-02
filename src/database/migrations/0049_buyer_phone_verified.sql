-- Track whether a buyer's phone number is verified (SMS OTP), separately from
-- their email. Guest orders matched by a *verified* identifier can be attached
-- to the account for reprice-with-approval; an unverified match never counts.
-- No phone-verification step exists yet, so this stays false for now - the
-- column is here so phone attachment drops in without a backfill later.
-- Hand-written and idempotent.

ALTER TABLE "buyers" ADD COLUMN IF NOT EXISTS "phone_verified" boolean DEFAULT false NOT NULL;
