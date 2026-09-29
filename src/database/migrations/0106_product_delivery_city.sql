-- A city-only item may name its own city again (a nationwide shop's cakes
-- that only go across Sylhet). Null - every row today - means the shop's
-- city, which is what "only one city" has meant since 0105.
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "delivery_city" varchar(80);
