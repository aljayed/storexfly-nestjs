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
 * A seller-requested change to an order's total that needs the buyer's consent
 * before it takes effect (e.g. a customization or add-on charge). Each row is
 * one proposal: it starts 'pending' and the buyer either approves it — at which
 * point the order's `totalCents` is rewritten to `newTotalCents` — or declines
 * it. Rows are never deleted, so the full list is the order's amount history
 * shown in the seller's order drawer and the buyer's profile.
 *
 * Status: 'pending' | 'approved' | 'rejected' | 'withdrawn' (seller-cancelled).
 * Only one 'pending' row may exist per order at a time.
 */
export const orderAmountAdjustments = pgTable(
  'order_amount_adjustments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    // Denormalized shop id so the row can be scoped without joining the order.
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    // The order total before this proposal (integer cents) — the "from" figure.
    previousTotalCents: integer('previous_total_cents').notNull(),
    // The proposed new order total (integer cents) — the "to" figure.
    newTotalCents: integer('new_total_cents').notNull(),
    reason: varchar('reason', { length: 300 }).notNull(),
    status: varchar('status', { length: 20 }).notNull().default('pending'),
    // When the buyer approved/declined, or the seller withdrew (null = pending).
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('order_amount_adjustments_order_idx').on(
      table.orderId,
      table.createdAt,
    ),
  ],
);

export const orderAmountAdjustmentsRelations = relations(
  orderAmountAdjustments,
  ({ one }) => ({
    order: one(orders, {
      fields: [orderAmountAdjustments.orderId],
      references: [orders.id],
    }),
  }),
);

export type OrderAmountAdjustmentRow =
  typeof orderAmountAdjustments.$inferSelect;
export type NewOrderAmountAdjustmentRow =
  typeof orderAmountAdjustments.$inferInsert;
