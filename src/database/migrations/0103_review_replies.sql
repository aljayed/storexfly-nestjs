-- A shop can answer a review in public, under the review itself. One reply per
-- review, which the shop can edit or remove; both columns are null until then.
ALTER TABLE "reviews" ADD COLUMN IF NOT EXISTS "reply" text;
--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN IF NOT EXISTS "replied_at" timestamp with time zone;
