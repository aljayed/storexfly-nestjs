-- Buyer profiles remember the payment method code used on their most recent
-- order, so checkout can preselect it next time. Idempotent by convention.
ALTER TABLE "buyers" ADD COLUMN IF NOT EXISTS "last_pay_method" varchar(64);
