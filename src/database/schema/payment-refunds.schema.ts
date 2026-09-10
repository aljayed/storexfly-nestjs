import { relations } from 'drizzle-orm';
import {
  index,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { orders } from './orders.schema';
import { paymentTransactions } from './payment-transactions.schema';

/**
 * One attempt to send a buyer's money back through the gateway that took it.
 *
 * A refund is not an event, it is a process: SSLCommerz answers 'success' to
 * mean "accepted for processing", and the money reaches the cardholder days
 * later. So it gets a row of its own rather than a flag on the order - the
 * order says the shop no longer owns the money, this says where the money
 * actually is.
 *
 * `refundTransId` is ours and is sent as the gateway's mandatory
 * `refund_trans_id`. It is generated before the call and stored with the row,
 * which is what makes a retry safe: the same refund filed twice carries the
 * same id, and the gateway answers 'processing' for the existing one rather
 * than paying the buyer twice.
 */
export const paymentRefunds = pgTable(
  'payment_refunds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id').references(() => orders.id, {
      onDelete: 'set null',
    }),
    /** The charge being reversed. Null once a transaction row is cleaned up. */
    transactionId: uuid('transaction_id').references(
      () => paymentTransactions.id,
      { onDelete: 'set null' },
    ),
    provider: varchar('provider', { length: 20 }).notNull(),
    /** Our idempotency key, sent as `refund_trans_id`. */
    refundTransId: varchar('refund_trans_id', { length: 30 }).notNull(),
    /** The gateway's own handle for it, returned on a successful filing. */
    refundRefId: varchar('refund_ref_id', { length: 60 }),
    /** What it was filed against - SSLCommerz `bank_tran_id`. */
    bankTranId: varchar('bank_tran_id', { length: 80 }),
    amountCents: integer('amount_cents').notNull(),
    /**
     * 'requested' - row written, gateway not answered yet (a crash between
     * the two leaves this, and the sweep picks it up).
     * 'processing' - filed and accepted; the money is on its way.
     * 'refunded'  - the gateway says the cardholder has it.
     * 'failed'    - the gateway refused; a human has to settle it.
     * 'manual'    - there was no gateway charge to reverse (cash on delivery,
     *               a direct wallet transfer), so somebody has to pay it back
     *               by hand. Recorded so it cannot be quietly forgotten.
     */
    status: varchar('status', { length: 20 }).notNull().default('requested'),
    /** Why the money is going back - shown to the buyer and sent as remarks. */
    reason: varchar('reason', { length: 255 }),
    /** The gateway's wording when it refuses. */
    errorReason: varchar('error_reason', { length: 500 }),
    /** 'seller' | 'auto' - a person asked, or a deadline ran out. */
    initiatedBy: varchar('initiated_by', { length: 20 })
      .notNull()
      .default('seller'),
    requestedAt: timestamp('requested_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** When the gateway confirmed the cardholder actually has it. */
    settledAt: timestamp('settled_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('payment_refunds_trans_unique_idx').on(table.refundTransId),
    index('payment_refunds_order_idx').on(table.orderId),
    // The poll that chases 'processing' refunds to a conclusion.
    index('payment_refunds_status_idx').on(table.status, table.requestedAt),
  ],
);

export const paymentRefundsRelations = relations(paymentRefunds, ({ one }) => ({
  order: one(orders, {
    fields: [paymentRefunds.orderId],
    references: [orders.id],
  }),
  transaction: one(paymentTransactions, {
    fields: [paymentRefunds.transactionId],
    references: [paymentTransactions.id],
  }),
}));

export type PaymentRefundRow = typeof paymentRefunds.$inferSelect;
export type NewPaymentRefundRow = typeof paymentRefunds.$inferInsert;
