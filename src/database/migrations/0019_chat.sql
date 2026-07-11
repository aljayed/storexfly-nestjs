-- Hoomri Chat: conversations, messages, quick replies.
-- Idempotent by convention (see 0015): dev databases may already carry these
-- objects via `db:push`, so every statement tolerates pre-existing state.
DO $$ BEGIN
 CREATE TYPE "public"."chat_message_status" AS ENUM('sent', 'delivered', 'read');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."chat_message_type" AS ENUM('text', 'product', 'order', 'image', 'file', 'system');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."chat_origin_type" AS ENUM('product', 'order');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."chat_sender_role" AS ENUM('customer', 'seller');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"buyer_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"origin_type" "chat_origin_type",
	"origin_ref_id" uuid,
	"buyer_unread" integer DEFAULT 0 NOT NULL,
	"seller_unread" integer DEFAULT 0 NOT NULL,
	"last_message_at" timestamp with time zone,
	"last_message_preview" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"sender_role" "chat_sender_role" NOT NULL,
	"sender_id" uuid NOT NULL,
	"type" "chat_message_type" NOT NULL,
	"text" text,
	"product" jsonb,
	"order" jsonb,
	"attachment" jsonb,
	"status" "chat_message_status" DEFAULT 'sent' NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_quick_replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"text" varchar(500) NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_buyer_id_buyers_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."buyers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_conversation_id_chat_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."chat_conversations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chat_quick_replies" ADD CONSTRAINT "chat_quick_replies_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chat_conversations_buyer_shop_unique_idx" ON "chat_conversations" USING btree ("buyer_id","shop_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_conversations_shop_idx" ON "chat_conversations" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_conversations_buyer_idx" ON "chat_conversations" USING btree ("buyer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_messages_conversation_sent_idx" ON "chat_messages" USING btree ("conversation_id","sent_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_quick_replies_shop_idx" ON "chat_quick_replies" USING btree ("shop_id");
