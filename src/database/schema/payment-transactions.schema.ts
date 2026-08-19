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
import { gatewayPayments } from './gateway-payments.schema';
import { orders } from './orders.schema';
import { shops } from './shops.schema';
import { users } from './users.schema';

/**
 * Every payment that actually moved money, one row each.
 *
 * Separate from `gateway_payments` because that table tracks a checkout
 * *session* and this one tracks money. The two are not one-to-one: a gateway
 * will settle the same session more than once if the buyer retries - a real
 * order here was paid three times against a single `tran_id` after a broken
 * redirect sent them back to try again - and each of those is a genuine
 * charge on someone's card that has to be visible somewhere.
 *
 * So nothing is deduplicated away. Each transaction is recorded on its own
 * terms and shown in the payer's history exactly as it happened, with the
 * order it was for. What is *not* repeated is the effect: an order settles
 * once, no matter how many times it was paid for, because that is guarded on
 * the session (see PaymentsService.claimSuccess).
 *
 * `gatewayTxnId` is the gateway's own reference - bKash's `trxID`,
 * SSLCommerz's `bank_tran_id` - and is unique per provider, which is what
 * makes recording idempotent: a redirect and an IPN describing the same
 * charge collapse to one row, while two real charges stay two rows.
 */
export const paymentTransactions = pgTable(
  'payment_transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // The checkout session this came back from. Kept even for a second
    // payment on an already-settled session - that is the link that explains
    // how the buyer ended up paying twice.
    gatewayPaymentId: uuid('gateway_payment_id')
      .notNull()
      .references(() => gatewayPayments.id, { onDelete: 'cascade' }),
    purpose: varchar('purpose', { length: 20 }).notNull().default('order'),
    // Denormalized from the session so a payer's history is one indexed read
    // rather than a join through sessions.
    orderId: uuid('order_id').references(() => orders.id, {
      onDelete: 'set null',
    }),
    shopId: uuid('shop_id').references(() => shops.id, { onDelete: 'set null' }),
    // Who paid, when they were signed in. Null for a guest checkout, whose
    // history is reached through the order's email instead.
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    provider: varchar('provider', { length: 20 }).notNull(),
    /** bKash `trxID` / SSLCommerz `bank_tran_id` - the receipt reference. */
    gatewayTxnId: varchar('gateway_txn_id', { length: 80 }).notNull(),
    /** SSLCommerz `val_id`, what a re-validation or refund is filed against. */
    valId: varchar('val_id', { length: 80 }),
    amountCents: integer('amount_cents').notNull(),
    currency: varchar('currency', { length: 3 }).notNull().default('BDT'),
    /** What it was paid with, as the gateway named it ('BKASH-BKash', 'VISA-…'). */
    instrument: varchar('instrument', { length: 60 }),
    capturedAt: timestamp('captured_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // The idempotency key: one row per real charge, however many times the
    // gateway tells us about it.
    uniqueIndex('payment_transactions_provider_txn_unique_idx').on(
      table.provider,
      table.gatewayTxnId,
    ),
    index('payment_transactions_order_idx').on(table.orderId),
    index('payment_transactions_shop_idx').on(table.shopId, table.capturedAt),
    index('payment_transactions_user_idx').on(table.userId, table.capturedAt),
    index('payment_transactions_session_idx').on(table.gatewayPaymentId),
  ],
);

export const paymentTransactionsRelations = relations(
  paymentTransactions,
  ({ one }) => ({
    session: one(gatewayPayments, {
      fields: [paymentTransactions.gatewayPaymentId],
      references: [gatewayPayments.id],
    }),
    order: one(orders, {
      fields: [paymentTransactions.orderId],
      references: [orders.id],
    }),
    shop: one(shops, {
      fields: [paymentTransactions.shopId],
      references: [shops.id],
    }),
  }),
);

export type PaymentTransactionRow = typeof paymentTransactions.$inferSelect;
export type NewPaymentTransactionRow = typeof paymentTransactions.$inferInsert;
