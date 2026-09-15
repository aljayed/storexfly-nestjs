CREATE TABLE "buyer_addresses" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "label" varchar(40) DEFAULT '' NOT NULL,
  "name" varchar(160) NOT NULL,
  "phone" varchar(24) NOT NULL,
  "address" text NOT NULL,
  "city" varchar(120) NOT NULL,
  "pincode" varchar(24) DEFAULT '' NOT NULL,
  "geo" jsonb,
  "is_default" boolean DEFAULT false NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "buyer_addresses_user_idx" ON "buyer_addresses" ("user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "buyer_addresses_one_default_idx" ON "buyer_addresses" ("user_id") WHERE "is_default" = true;
--> statement-breakpoint
-- Preserve existing delivery details once. Deleting the last address later
-- must never recreate it from these legacy profile fields.
INSERT INTO "buyer_addresses" ("user_id", "name", "phone", "address", "city", "pincode", "geo", "is_default")
SELECT "id", "name", regexp_replace(regexp_replace("phone", '[^0-9]', '', 'g'), '^(880)?0?', ''),
       "address_line", "address_city", coalesce("address_pincode", ''), "geo", true
FROM "users"
WHERE length(trim(coalesce("address_line", ''))) > 0
  AND length(trim(coalesce("address_city", ''))) > 0
  AND length(trim("name")) > 0
  AND regexp_replace(regexp_replace("phone", '[^0-9]', '', 'g'), '^(880)?0?', '') ~ '^1[3-9][0-9]{8}$';
