ALTER TYPE "public"."product_tag" ADD VALUE 'Sale';--> statement-breakpoint
ALTER TYPE "public"."product_tag" ADD VALUE 'Limited';--> statement-breakpoint
ALTER TYPE "public"."product_tag" ADD VALUE 'Popular';--> statement-breakpoint
ALTER TYPE "public"."product_tag" ADD VALUE 'Trending';--> statement-breakpoint
ALTER TYPE "public"."product_tag" ADD VALUE 'Premium';--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "payment_methods" "payment_method"[] DEFAULT '{"mbank","card","cod"}' NOT NULL;