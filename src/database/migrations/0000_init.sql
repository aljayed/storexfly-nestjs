CREATE TYPE "public"."admin_role" AS ENUM('owner', 'manager', 'staff');--> statement-breakpoint
CREATE TYPE "public"."auth_method" AS ENUM('email', 'google', 'phone');--> statement-breakpoint
CREATE TYPE "public"."brand_swatch" AS ENUM('amber', 'blue', 'green', 'rose', 'violet', 'clay');--> statement-breakpoint
CREATE TYPE "public"."customer_segment" AS ENUM('VIP', 'Repeat', 'New');--> statement-breakpoint
CREATE TYPE "public"."mobile_bank_app" AS ENUM('bkash', 'nagad', 'rocket');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('New', 'Packed', 'Shipped', 'Delivered');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('mbank', 'card', 'cod');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('Paid', 'Refunded');--> statement-breakpoint
CREATE TYPE "public"."product_tag" AS ENUM('Bestseller', 'In season', 'Gift', 'Snack', 'New');--> statement-breakpoint
CREATE TYPE "public"."sales_channel" AS ENUM('Store', 'Instagram', 'WhatsApp');--> statement-breakpoint
CREATE TYPE "public"."shop_category" AS ENUM('Food & grocery', 'Fashion', 'Handmade', 'Beauty', 'Home goods', 'Bakery', 'Other');--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(160) NOT NULL,
	"email" varchar(320),
	"phone" varchar(24),
	"password_hash" text,
	"via" "auth_method" DEFAULT 'email' NOT NULL,
	"google_id" varchar(64),
	"is_admin" boolean DEFAULT false NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(160) NOT NULL,
	"handle" varchar(80) NOT NULL,
	"tagline" varchar(240),
	"cat" "shop_category" DEFAULT 'Other' NOT NULL,
	"brand_id" "brand_swatch" DEFAULT 'amber' NOT NULL,
	"brand" varchar(9) NOT NULL,
	"brand_soft" varchar(9) NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(160) NOT NULL,
	"email" varchar(320) NOT NULL,
	"password_hash" text NOT NULL,
	"role" "admin_role" DEFAULT 'staff' NOT NULL,
	"shop_id" uuid NOT NULL,
	"two_factor_enabled" boolean DEFAULT false NOT NULL,
	"two_factor_secret" text,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"slug" varchar(220) NOT NULL,
	"cat" varchar(80) NOT NULL,
	"price_cents" integer NOT NULL,
	"unit" varchar(60) NOT NULL,
	"stock" integer DEFAULT 0 NOT NULL,
	"emoji" varchar(16) DEFAULT '📦' NOT NULL,
	"tone" varchar(9) DEFAULT '#f3f1ec' NOT NULL,
	"tag" "product_tag",
	"rating" double precision DEFAULT 0 NOT NULL,
	"reviews_count" integer DEFAULT 0 NOT NULL,
	"blurb" text DEFAULT '' NOT NULL,
	"images" text[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"author" varchar(160) NOT NULL,
	"rating" integer NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"name" varchar(160) NOT NULL,
	"email" varchar(320) NOT NULL,
	"city" varchar(120) DEFAULT '' NOT NULL,
	"orders_count" integer DEFAULT 0 NOT NULL,
	"spent_cents" integer DEFAULT 0 NOT NULL,
	"first_order_at" timestamp with time zone,
	"last_order_at" timestamp with time zone,
	"segment" "customer_segment" DEFAULT 'New' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"product_id" uuid,
	"name" varchar(200) NOT NULL,
	"qty" integer NOT NULL,
	"unit_price_cents" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" varchar(16) NOT NULL,
	"shop_id" uuid NOT NULL,
	"customer_id" uuid,
	"customer_name" varchar(160) NOT NULL,
	"email" varchar(320) NOT NULL,
	"phone" varchar(24),
	"qty" integer NOT NULL,
	"total_cents" integer NOT NULL,
	"status" "order_status" DEFAULT 'New' NOT NULL,
	"pay" "payment_status" DEFAULT 'Paid' NOT NULL,
	"payment_method" "payment_method",
	"mobile_bank_app" "mobile_bank_app",
	"channel" "sales_channel" DEFAULT 'Store' NOT NULL,
	"address" jsonb,
	"placed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shops" ADD CONSTRAINT "shops_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_users" ADD CONSTRAINT "admin_users_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique_idx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "users_google_id_unique_idx" ON "users" USING btree ("google_id");--> statement-breakpoint
CREATE INDEX "users_phone_idx" ON "users" USING btree ("phone");--> statement-breakpoint
CREATE UNIQUE INDEX "shops_handle_unique_idx" ON "shops" USING btree ("handle");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_users_email_unique_idx" ON "admin_users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "products_shop_slug_unique_idx" ON "products" USING btree ("shop_id","slug");--> statement-breakpoint
CREATE INDEX "products_shop_cat_idx" ON "products" USING btree ("shop_id","cat");--> statement-breakpoint
CREATE INDEX "reviews_product_idx" ON "reviews" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_shop_email_unique_idx" ON "customers" USING btree ("shop_id","email");--> statement-breakpoint
CREATE INDEX "customers_shop_segment_idx" ON "customers" USING btree ("shop_id","segment");--> statement-breakpoint
CREATE INDEX "order_items_order_idx" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_shop_reference_unique_idx" ON "orders" USING btree ("shop_id","reference");--> statement-breakpoint
CREATE INDEX "orders_shop_status_idx" ON "orders" USING btree ("shop_id","status");--> statement-breakpoint
CREATE INDEX "orders_shop_channel_idx" ON "orders" USING btree ("shop_id","channel");--> statement-breakpoint
CREATE INDEX "orders_customer_idx" ON "orders" USING btree ("customer_id");