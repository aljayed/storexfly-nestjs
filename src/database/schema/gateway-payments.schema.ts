import { relations } from 'drizzle-orm';
import {
  index,
  integer,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { orders } from './orders.schema';

/**
 * One attempt to collect an order's money through a hosted gateway (bKash
 * Tokenized Checkout, or SSLCommerz). The order sits in pay='Pending' while a
 * row here is 'created'; capturing the payment flips both to success. Stale
 * attempts are expired by a sweep, which cancels + restocks the pending order.
 *
 * `paymentId` is whichever id identifies the attempt to that gateway on the
 * way back: bKash mints it (`paymentID`), SSLCommerz takes ours (`tran_id`).
 * Either way it is what the return leg looks the attempt up by, so it is
 * unique per attempt for both.
 */
export const gatewayPayments = pgTable(
  'gateway_payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    provider: varchar('provider', { length: 20 }).notNull().default('bkash'),
    // The id the attempt is known by at the gateway - bKash's `paymentID`,
    // or the `tran_id` we mint for an SSLCommerz session.
    paymentId: varchar('payment_id', { length: 80 }).notNull(),
    status: varchar('status', { length: 20 }).notNull().default('created'),
    amountCents: integer('amount_cents').notNull(),
    // Gateway transaction id on success (bKash `trxID`, SSLCommerz
    // `bank_tran_id`) - the buyer's receipt reference, the reconciliation key
    // against the merchant statement, and what a refund is filed against.
    trxId: varchar('trx_id', { length: 80 }),
    payerReference: varchar('payer_reference', { length: 40 }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index('gateway_payments_order_idx').on(table.orderId),
    index('gateway_payments_payment_idx').on(table.paymentId),
    index('gateway_payments_status_idx').on(table.status, table.createdAt),
  ],
);

export const gatewayPaymentsRelations = relations(
  gatewayPayments,
  ({ one }) => ({
    order: one(orders, {
      fields: [gatewayPayments.orderId],
      references: [orders.id],
    }),
  }),
);

export type GatewayPaymentRow = typeof gatewayPayments.$inferSelect;
export type NewGatewayPaymentRow = typeof gatewayPayments.$inferInsert;
