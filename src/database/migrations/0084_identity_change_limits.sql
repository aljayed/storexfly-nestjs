-- Rationing the two names an account is addressed by.
--
-- A username and a phone number are both things other people reach this
-- account through: chat resolves "@rafiq", and the number on a parcel is what
-- a courier rings. Either could be churned through freely - so a stolen
-- session could rename an account out from under its owner, and a handle could
-- be flipped between people faster than anyone could notice.
--
-- Two counters, kept on the account itself rather than in a history table,
-- because nothing needs the history - only whether a change is allowed now:
--   * `handle_changed_at` - one username change per 30 days.
--   * `phone_changes`     - two phone changes per rolling 14 days, as a list
--                           of ISO timestamps newest-first, trimmed to the
--                           entries still inside that window.
--
-- Both start empty, so every existing account may change either once straight
-- away - the limits begin counting from the next change, not retroactively.
--
-- Idempotent by convention: re-running changes nothing.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "handle_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "phone_changes" jsonb;--> statement-breakpoint

-- ── One number, one string ────────────────────────────────────────
-- `users.phone` was written in two shapes: checkout and the buyer profile
-- store the bare national digits ("1712345678"), while the account's own OTP
-- verification stored E.164 ("+8801712345678"). Nothing compares the two, so
-- an account verified through the create-shop wizard did not match its own
-- orders, and its number read as unclaimed to the uniqueness check.
--
-- The national form wins - it is what every other column and query already
-- holds - so the E.164 rows are folded into it. Only rows that are purely a
-- BD number are touched; anything else is left exactly as it is.
UPDATE "users"
   SET "phone" = regexp_replace("phone", '^\+?880', '')
 WHERE "phone" ~ '^\+?880[0-9]{10}$';
