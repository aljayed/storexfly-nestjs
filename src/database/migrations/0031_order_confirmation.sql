-- Confirmation gate for the order pipeline: sellers call the buyer to confirm
-- ('Confirmed') before an order is packed; unconfirmed orders can be voided
-- ('Cancelled'). Hand-written and idempotent (see 0025/0030 for why we avoid
-- `drizzle-kit generate` here). Values are appended to the existing enum; the
-- logical flow lives in the orders service, not the enum order.
ALTER TYPE "public"."order_status" ADD VALUE IF NOT EXISTS 'Confirmed';--> statement-breakpoint
ALTER TYPE "public"."order_status" ADD VALUE IF NOT EXISTS 'Cancelled';
