ALTER TABLE "payment_links" ADD COLUMN "currency" varchar(3) DEFAULT 'BDT' NOT NULL;
--> statement-breakpoint
ALTER TABLE "payment_links" ADD COLUMN "settled_amount_cents" integer;
--> statement-breakpoint
ALTER TABLE "gateway_payments" ADD COLUMN "currency" varchar(3) DEFAULT 'BDT' NOT NULL;
--> statement-breakpoint
-- Every existing link was charged in BDT. Prefer the captured gross amount
-- when available so historical overpayments also reconcile with the ledger.
UPDATE "payment_links" AS link
SET "settled_amount_cents" = COALESCE(
  (SELECT txn."amount_cents" FROM "payment_transactions" AS txn
   WHERE txn."provider" = 'sslcommerz' AND txn."gateway_txn_id" = link."trx_id"),
  link."amount_cents"
)
WHERE link."status" IN ('paid', 'refunded');
--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_currency_check"
  CHECK ("currency" IN ('BDT', 'USD', 'INR'));
