-- A shop that has been filled in and is waiting for the pack that opens it.
-- The row holds its handle while the seller is away on the payment page;
-- the partial unique index is the reservation, and it lapses with the draft.
CREATE TABLE "shop_drafts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "handle" varchar(80) NOT NULL,
  "name" varchar(160) NOT NULL,
  "payload" jsonb NOT NULL,
  "pack_code" varchar(32),
  "coupon_code" varchar(40),
  "status" varchar(20) DEFAULT 'pending' NOT NULL,
  "shop_id" uuid REFERENCES "shops"("id") ON DELETE SET NULL,
  "expires_at" timestamptz NOT NULL,
  "paid_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "shop_drafts_handle_pending_idx" ON "shop_drafts" ("handle") WHERE "status" = 'pending';
--> statement-breakpoint
CREATE INDEX "shop_drafts_owner_idx" ON "shop_drafts" ("owner_id", "status");
--> statement-breakpoint
CREATE INDEX "shop_drafts_expiry_idx" ON "shop_drafts" ("status", "expires_at");
--> statement-breakpoint
-- A shop-opening payment is collected before there is a shop to hang it on.
ALTER TABLE "gateway_payments" ADD COLUMN "shop_draft_id" uuid REFERENCES "shop_drafts"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE INDEX "gateway_payments_draft_idx" ON "gateway_payments" ("shop_draft_id");
