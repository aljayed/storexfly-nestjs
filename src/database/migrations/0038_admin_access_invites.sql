-- Shop-admin access management: a fourth console role tier and email invites.
-- Hand-written (not db:generate) so it stays idempotent and free of drift —
-- see 0025 for the precedent.

ALTER TYPE "public"."admin_role" ADD VALUE IF NOT EXISTS 'editor';--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "admin_invites" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "shop_id" uuid NOT NULL,
        "email" varchar(320) NOT NULL,
        "role" "admin_role" DEFAULT 'staff' NOT NULL,
        "token_hash" text NOT NULL,
        "invited_by_id" uuid,
        "expires_at" timestamp with time zone NOT NULL,
        "accepted_at" timestamp with time zone,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

DO $$ BEGIN
        ALTER TABLE "admin_invites" ADD CONSTRAINT "admin_invites_shop_id_shops_id_fk"
                FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

DO $$ BEGIN
        ALTER TABLE "admin_invites" ADD CONSTRAINT "admin_invites_invited_by_id_admin_users_id_fk"
                FOREIGN KEY ("invited_by_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "admin_invites_token_hash_unique_idx" ON "admin_invites" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "admin_invites_shop_email_unique_idx" ON "admin_invites" USING btree ("shop_id","email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_invites_shop_idx" ON "admin_invites" USING btree ("shop_id");
