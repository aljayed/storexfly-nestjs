-- Anti-abuse ledger. One row per signup or order attempt, keyed by HMACs of
-- the identifiers rather than the identifiers themselves: the only question it
-- ever answers is "same one again?", which equality over a hash settles.

CREATE TYPE "public"."risk_event_kind" AS ENUM('signup', 'order');--> statement-breakpoint

CREATE TABLE "risk_events" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "kind" "risk_event_kind" NOT NULL,
        "phone_hash" varchar(64),
        "email_hash" varchar(64),
        "ip_hash" varchar(64),
        "device_hash" varchar(64),
        "account_id" uuid,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL,
        CONSTRAINT "risk_events_account_id_users_id_fk"
                FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE set null
);--> statement-breakpoint

CREATE INDEX "risk_events_phone_idx" ON "risk_events" USING btree ("kind","phone_hash","created_at");--> statement-breakpoint
CREATE INDEX "risk_events_email_idx" ON "risk_events" USING btree ("kind","email_hash","created_at");--> statement-breakpoint
CREATE INDEX "risk_events_ip_idx" ON "risk_events" USING btree ("kind","ip_hash","created_at");--> statement-breakpoint
CREATE INDEX "risk_events_device_idx" ON "risk_events" USING btree ("kind","device_hash","created_at");--> statement-breakpoint
CREATE INDEX "risk_events_created_idx" ON "risk_events" USING btree ("created_at");
