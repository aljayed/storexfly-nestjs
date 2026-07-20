-- Shop deletion guards + settlement survival.
-- 1) shops.payout_bank: the bank/wallet account settlements are transferred to.
-- 2) deleted_shop_settlements: unpaid payouts snapshotted when a shop is
--    deleted, so the platform still owes (and can record) the money after the
--    shop's orders and settlements have cascaded away.
-- Idempotent: every statement is safe to re-run.

ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "payout_bank" jsonb;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "deleted_shop_settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"shop_name" varchar(160) NOT NULL,
	"shop_handle" varchar(80) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"owner_id" uuid,
	"owner_email" varchar(320),
	"period" varchar(7) NOT NULL,
	"orders_count" integer NOT NULL,
	"total_cents" integer NOT NULL,
	"fee_cents" integer NOT NULL,
	"payout_cents" integer NOT NULL,
	"breakdown" jsonb,
	"payout_bank" jsonb,
	"owed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone,
	"note" varchar(200)
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "deleted_shop_settlements" ADD CONSTRAINT "deleted_shop_settlements_owner_id_users_id_fk"
    FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deleted_shop_settlements_paid_idx"
  ON "deleted_shop_settlements" USING btree ("paid_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deleted_shop_settlements_shop_idx"
  ON "deleted_shop_settlements" USING btree ("shop_id");
