ALTER TABLE "platform_settings" DROP COLUMN "logo_url";--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "logo_light" text;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "logo_dark" text;