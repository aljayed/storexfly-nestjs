-- Staff mailboxes on the platform's own mail domain, managed from the console.
--
-- Only metadata lives here. The mailserver's postfix-accounts.cf stays the
-- account store - it is what Dovecot authenticates against, and a second copy
-- would only create two truths about who has a mailbox. This table answers
-- the one question the mailserver has no opinion on: may an operator delete
-- this box.
--
-- Reconciliation happens on every listing: an address in the file with no row
-- here gets one, locked. So the boxes that came with the server - no-reply@,
-- support@, contact@ - are protected without anyone having to name them, and
-- so is anything added over SSH later.
--
-- Idempotent by convention: re-running changes nothing.

CREATE TABLE IF NOT EXISTS "mail_accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "address" varchar(320) NOT NULL,
  "label" varchar(120),
  "locked" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "mail_accounts_address_unique_idx"
  ON "mail_accounts" ("address");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_accounts_locked_idx"
  ON "mail_accounts" ("locked");
