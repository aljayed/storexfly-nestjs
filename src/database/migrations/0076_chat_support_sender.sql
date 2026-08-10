-- Hoomri Support authors messages too, and "customer or seller" cannot say so.
--
-- ADD VALUE rather than a new type: the enum is on a hot table and rewriting
-- it would rewrite every row. The value is unused until the first support
-- message, so this is safe to apply ahead of the code that writes it.
ALTER TYPE "public"."chat_sender_role" ADD VALUE IF NOT EXISTS 'support';
