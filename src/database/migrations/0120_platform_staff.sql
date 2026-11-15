-- Platform console: named staff accounts, roles by workspace, and an
-- append-only audit log. Replaces the single shared operator login.
CREATE TABLE IF NOT EXISTS "platform_roles" (
  "key" varchar(40) PRIMARY KEY,
  "name" varchar(80) NOT NULL,
  "description" varchar(300),
  "grants" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "system" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_staff" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" varchar(160) NOT NULL,
  "email" varchar(320) NOT NULL,
  "password_hash" text,
  "role_key" varchar(40) NOT NULL REFERENCES "platform_roles"("key") ON UPDATE CASCADE,
  "status" varchar(16) DEFAULT 'active' NOT NULL,
  "must_change_password" boolean DEFAULT true NOT NULL,
  "two_factor_enabled" boolean DEFAULT false NOT NULL,
  "two_factor_secret" text,
  "session_version" integer DEFAULT 1 NOT NULL,
  "last_login_at" timestamp with time zone,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_staff_email_idx" ON "platform_staff" ("email");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_audit_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "actor_id" uuid,
  "actor_name" varchar(160),
  "actor_email" varchar(320),
  "actor_role" varchar(80),
  "workspace" varchar(20),
  "action" varchar(120) NOT NULL,
  "method" varchar(8),
  "path" varchar(300),
  "target_id" varchar(120),
  "outcome" varchar(16) DEFAULT 'ok' NOT NULL,
  "status_code" integer,
  "details" jsonb,
  "ip" varchar(64),
  "user_agent" varchar(300),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_audit_created_idx" ON "platform_audit_log" ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_audit_actor_idx" ON "platform_audit_log" ("actor_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_audit_workspace_idx" ON "platform_audit_log" ("workspace", "created_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "platform_audit_log_immutable"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'platform_audit_log is append-only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "platform_audit_log_no_change" ON "platform_audit_log";
--> statement-breakpoint
CREATE TRIGGER "platform_audit_log_no_change"
  BEFORE UPDATE OR DELETE ON "platform_audit_log"
  FOR EACH ROW EXECUTE FUNCTION "platform_audit_log_immutable"();
--> statement-breakpoint
INSERT INTO "platform_roles" ("key", "name", "description", "grants", "system") VALUES
  ('owner', 'Platform owner', 'Everything, including team and access.',
    '{"sellers":"approve","catalog":"approve","orders":"approve","support":"approve","risk":"approve","finance":"approve","growth":"approve","insights":"approve","system":"approve","access":"approve"}', true),
  ('head_of_operations', 'Head of operations', 'Runs the marketplace teams and signs off shop closures.',
    '{"sellers":"approve","catalog":"approve","orders":"approve","support":"approve","risk":"view","finance":"view","growth":"view","insights":"view","access":"view"}', true),
  ('seller_ops', 'Seller ops agent', 'Looks after shops: messages, suspensions, verification.',
    '{"sellers":"act","catalog":"view","orders":"view","support":"view"}', true),
  ('kyc_reviewer', 'KYC reviewer', 'Reviews trade licences and business details.',
    '{"sellers":"act","risk":"view"}', true),
  ('catalog_moderator', 'Catalog moderator', 'Keeps listings legal and honest.',
    '{"sellers":"view","catalog":"act"}', true),
  ('support_agent', 'Support agent', 'Answers the support inbox and works disputes.',
    '{"sellers":"view","orders":"view","support":"act"}', true),
  ('support_lead', 'Support lead', 'Leads support and decides escalated disputes.',
    '{"sellers":"view","catalog":"view","orders":"act","support":"approve","risk":"view","finance":"view","insights":"view"}', true),
  ('risk_analyst', 'Risk analyst', 'Works face checks and fraud signals.',
    '{"sellers":"view","catalog":"view","orders":"view","support":"view","risk":"act","finance":"view","insights":"view"}', true),
  ('finance_agent', 'Finance agent', 'Records payouts and shop payments.',
    '{"sellers":"view","orders":"view","support":"view","finance":"act"}', true),
  ('finance_lead', 'Finance lead', 'Owns payouts and signs off pricing changes.',
    '{"sellers":"view","orders":"view","support":"view","risk":"view","finance":"approve","insights":"view"}', true),
  ('marketing', 'Marketing manager', 'Runs coupons, referral links and notices.',
    '{"catalog":"view","growth":"act","insights":"view"}', true),
  ('system_admin', 'System admin', 'Manages gateways, email and branding.',
    '{"system":"act","access":"view"}', true)
ON CONFLICT ("key") DO NOTHING;
