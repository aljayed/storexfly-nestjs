-- One trade licence, one shop. Matched on the number with whitespace stripped
-- and upper-cased, so the same licence cannot be duplicated by retyping it
-- with different spacing or case. Partial: shops that submitted no licence
-- (the common case - KYC is optional) are all null and never collide.
--
-- Deleting a shop frees its licence, because the row is deleted outright.
CREATE UNIQUE INDEX IF NOT EXISTS "shops_kyc_license_unique_idx"
  ON "shops" (upper(regexp_replace("kyc_license_no", '\s', '', 'g')))
  WHERE "kyc_license_no" IS NOT NULL;
