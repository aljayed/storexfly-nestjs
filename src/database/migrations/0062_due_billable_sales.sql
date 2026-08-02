-- Remember what sales an issued-but-unpaid commission bill was charged on.
--
-- Paying a bill by hand used to back-derive that figure from the amount and
-- the rate (`due_cents * 10000 / commission_bps`). That is wrong whenever the
-- operator changes the rate between the bill being issued and it being paid —
-- which became possible once the rate turned into a console setting — and a
-- payment record carrying a wrong basis is worse than one carrying none.
--
-- Idempotent by convention: re-running changes nothing.

ALTER TABLE "subscriptions"
  ADD COLUMN IF NOT EXISTS "due_billable_sales_cents" bigint;
