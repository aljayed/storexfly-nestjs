-- Proof that a payout actually left the platform: the receipt an operator
-- uploads when they record the transfer, kept so the seller can see it in
-- their own settlement history.
--
-- A list rather than one file: a cycle can be paid out more than once (an
-- open cycle keeps taking deliveries, so the operator records the rest
-- later), and each of those transfers has its own receipt. Overwriting would
-- lose the earlier one.
--
-- The receipts are held inline as base64 data URLs, the way trade licences
-- are. A payment receipt should not live behind the public media proxy; this
-- keeps it on authenticated routes only.
ALTER TABLE "settlements" ADD COLUMN IF NOT EXISTS "proofs" jsonb;
ALTER TABLE "deleted_shop_settlements" ADD COLUMN IF NOT EXISTS "proofs" jsonb;
