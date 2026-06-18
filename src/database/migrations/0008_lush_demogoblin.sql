CREATE TABLE "platform_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brand_wordmark" varchar(40) DEFAULT 'hoomri' NOT NULL,
	"brand_accent" varchar(40) DEFAULT 'oo',
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
