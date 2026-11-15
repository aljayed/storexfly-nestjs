import {
  index,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { paymentTransactions } from './payment-transactions.schema';
import { shops } from './shops.schema';

/**
 * Money a shop has paid the platform against its service-fee balance.
 *
 * A seller who collects an order's money themself - cash on delivery, a
 * direct transfer - owes the platform its service fee afterwards, and on a
 * reseller order the reseller's margin with it. This is the ledger of what
 * they have paid back. What they *owe* is never stored: it is read off the
 * orders (see ServiceFeesService), so a refund or a cancellation corrects
 * the balance without anything having to un-write a row.
 *
 * `via` is how the money arrived: 'gateway' is the seller paying from the
 * console, 'manual' is an operator recording a transfer they received, and
 * 'payout' is the platform keeping it back from a payout it owed the shop
 * (`payoutPeriod` names the cycle, which is what undoing that payout
 * removes the row by).
 */
export const serviceFeePayments = pgTable(
  'service_fee_payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    amountCents: integer('amount_cents').notNull(),
    via: varchar('via', { length: 12 })
      .$type<'gateway' | 'manual' | 'payout'>()
      .notNull(),
    /** Which gateway collected it ('bkash', 'sslcommerz'); null = manual. */
    gateway: varchar('gateway', { length: 20 }),
    /** The gateway's reference, or null on a transfer recorded by hand. */
    gatewayTxnId: varchar('gateway_txn_id', { length: 80 }),
    paymentTransactionId: uuid('payment_transaction_id').references(
      () => paymentTransactions.id,
      { onDelete: 'set null' },
    ),
    /** via='payout': the payout cycle it was kept back from ("YYYY-MM"). */
    payoutPeriod: varchar('payout_period', { length: 7 }),
    /** Operator's reference for a manual payment (bank trx id, ...). */
    note: varchar('note', { length: 200 }),
    /** Operator who recorded a manual payment. */
    recordedBy: varchar('recorded_by', { length: 254 }),
    paidAt: timestamp('paid_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('service_fee_payments_shop_idx').on(table.shopId, table.paidAt),
    index('service_fee_payments_payout_idx').on(
      table.shopId,
      table.payoutPeriod,
    ),
    // One ledger row per gateway charge, however many times the gateway
    // tells us about it.
    uniqueIndex('service_fee_payments_txn_unique_idx').on(
      table.gateway,
      table.gatewayTxnId,
    ),
  ],
);

export type ServiceFeePaymentRow = typeof serviceFeePayments.$inferSelect;
export type NewServiceFeePaymentRow = typeof serviceFeePayments.$inferInsert;
