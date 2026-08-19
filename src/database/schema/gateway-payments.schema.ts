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
import { shops } from './shops.schema';

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
 *
 * An attempt is a *session*, not money. A gateway will happily settle the
 * same session more than once - a buyer who retries after a failed redirect
 * really is charged twice - so what actually moved is recorded per
 * transaction in `payment_transactions`, and this row only ever tracks
 * whether the session reached a decision.
 *
 * `purpose` says what the session is collecting for. 'order' is a buyer
 * paying a shop, and carries `orderId`. 'credit_pack' is a seller paying the
 * platform for sales credit, and carries the shop plus what was being bought
 * - held here rather than granted up front so an abandoned checkout grants
 * nothing.
 */
export const gatewayPayments = pgTable(
  'gateway_payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Which kind of thing this session is paying for.
    purpose: varchar('purpose', { length: 20 }).notNull().default('order'),
    // purpose='order': the order being paid. Null on a credit-pack purchase.
    orderId: uuid('order_id').references(() => orders.id, {
      onDelete: 'cascade',
    }),
    // purpose='credit_pack': the shop buying, and the pack it picked. The
    // coupon is held rather than redeemed until the money actually lands.
    shopId: uuid('shop_id').references(() => shops.id, { onDelete: 'cascade' }),
    packCode: varchar('pack_code', { length: 32 }),
    couponCode: varchar('coupon_code', { length: 40 }),
    discountCents: integer('discount_cents').notNull().default(0),
    /** Referral link the seller arrived through, credited once they pay. */
    refSlug: varchar('ref_slug', { length: 60 }),
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
    index('gateway_payments_shop_idx').on(table.shopId),
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
