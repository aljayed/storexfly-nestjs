-- Quick replies: platform-seeded defaults become non-deletable.
-- Idempotent by convention (see 0015): dev databases may already carry these
-- objects via `db:push`, so every statement tolerates pre-existing state.
ALTER TABLE "chat_quick_replies" ADD COLUMN IF NOT EXISTS "is_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Shops seeded before this column existed: re-mark the starter set as default.
UPDATE "chat_quick_replies" SET "is_default" = true WHERE "text" IN (
	'Thanks for reaching out! 🙌',
	'Yes, that’s in stock right now.',
	'Let me check and get back to you shortly.',
	'We offer free replacement for damaged items.'
);
