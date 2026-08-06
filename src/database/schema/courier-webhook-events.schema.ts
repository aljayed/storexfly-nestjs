import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { orders } from './orders.schema';

/**
 * Every courier callback we accept, written down before it is acted on.
 *
 * The courier is the source of truth for whether an order shipped, was
 * delivered and whether its COD cash was collected - so a dropped callback is
 * money, not just a stale badge. Handling one inline and logging the failure
 * would leave no way to find out what was missed, or to prove to the courier
 * what they did and didn't send.
 *
 * This is deliberately a table and not a message broker. At the volume a
 * parcel generates - a dozen events over its life - Postgres is comfortably
 * the right queue, and it buys durability, an audit trail and replay without
 * another piece of infrastructure to run, secure and lose messages in.
 *
 * A row is inserted on receipt, processed immediately, and marked done. One
 * that fails is retried by the sweep in OrdersService until it succeeds or
 * runs out of attempts, which is where an operator picks it up.
 */
export const courierWebhookEvents = pgTable(
  'courier_webhook_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: varchar('provider', { length: 20 }).notNull().default('carrybee'),
    /** The courier's own event name, e.g. 'order.delivered'. */
    event: varchar('event', { length: 60 }).notNull(),
    consignmentId: varchar('consignment_id', { length: 64 }),
    merchantOrderId: varchar('merchant_order_id', { length: 64 }),
    /** Resolved once the consignment is matched; null when it never was. */
    orderId: uuid('order_id').references(() => orders.id, {
      onDelete: 'set null',
    }),
    /** The callback verbatim - what makes a replay a replay and not a guess. */
    payload: jsonb('payload').notNull(),
    /** The courier's timestamp for the event, not ours. */
    eventAt: timestamp('event_at', { withTimezone: true }),
    receivedAt: timestamp('received_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** null = still owed. Set once the order has been moved (or knowingly
     *  not moved - an event about an order we do not have is complete). */
    processedAt: timestamp('processed_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
  },
  (table) => [
    // The sweep's working set: rows still owed, oldest first.
    index('courier_webhook_pending_idx').on(
      table.processedAt,
      table.receivedAt,
    ),
    index('courier_webhook_consignment_idx').on(table.consignmentId),
  ],
);

export type CourierWebhookEventRow = typeof courierWebhookEvents.$inferSelect;
export type NewCourierWebhookEventRow =
  typeof courierWebhookEvents.$inferInsert;
