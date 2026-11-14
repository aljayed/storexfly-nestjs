-- Face verification: one free shop per person. An account proves a live face
-- that is on no other account before it may open a shop. Vectors only - no
-- photo is stored.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "face_verified_at" timestamp with time zone;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "face_templates" (
  "user_id" uuid PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
  "embedding" real[] NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "face_template_samples" (
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "slot" integer NOT NULL,
  "embedding" real[] NOT NULL,
  PRIMARY KEY ("user_id", "slot")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "face_checks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "session_id" uuid,
  "passed" boolean NOT NULL,
  "reason" varchar(40),
  "policy_version" varchar(80),
  "liveness" real,
  "consistency" real,
  "duplicate_of_id" uuid,
  "duplicate_score" real,
  "flagged" boolean NOT NULL DEFAULT false,
  "reviewed_at" timestamp with time zone,
  "reviewed_by" varchar(254),
  "review_note" varchar(1000),
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "face_checks_user_idx" ON "face_checks" ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "face_checks_flagged_idx" ON "face_checks" ("flagged", "reviewed_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "face_system" (
  "id" integer PRIMARY KEY,
  "compatibility" varchar(64) NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- Hoomri is free: nothing is owed and nothing runs out. Clear the marks the
-- old billing left so no shop stays paused over a balance or a bill.
UPDATE "subscriptions" SET "due_cents" = 0, "due_since" = NULL, "credit_exhausted_at" = NULL
  WHERE "due_cents" <> 0 OR "credit_exhausted_at" IS NOT NULL;
