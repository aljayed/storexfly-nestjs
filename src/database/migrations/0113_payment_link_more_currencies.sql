-- Payment links can now ask for every currency SSLCommerz converts, not only
-- USD and INR. Widen the guard to match PAYMENT_LINK_CURRENCIES.
ALTER TABLE "payment_links" DROP CONSTRAINT IF EXISTS "payment_links_currency_check";
--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_currency_check"
  CHECK ("currency" IN ('BDT', 'USD', 'EUR', 'GBP', 'INR', 'SGD', 'MYR', 'AUD', 'SAR', 'QAR', 'THB'));
