import { relations } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { shops } from './shops.schema';

/** One online payment method's snapshotted slice of a paid settlement. */
export interface SettlementMethodSnapshot {
  code: string;
  title: string;
  cents: number;
  feeBp: number;
  feeCents: number;
}

/**
 * A completed monthly payout of a shop's prepaid (online) order revenue.
 * Pending settlements are always computed live from `orders`; a row is only
 * written when a platform operator marks the month as paid, snapshotting the
 * amounts as they were at payment time so the record stays immutable even if
 * orders are later refunded or fee rates change. Undoing a payment deletes
 * the row. `period` is the earnings month as "YYYY-MM"; money in integer
 * cents of the shop's currency.
 */
export const settlements = pgTable(
  'settlements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    period: varchar('period', { length: 7 }).notNull(),
    ordersCount: integer('orders_count').notNull(),
    totalCents: integer('total_cents').notNull(),
    codCents: integer('cod_cents').notNull(),
    mbankCents: integer('mbank_cents').notNull(),
    cardCents: integer('card_cents').notNull(),
    otherCents: integer('other_cents').notNull(),
    feeCents: integer('fee_cents').notNull(),
    payoutCents: integer('payout_cents').notNull(),
    // Fee rates (basis points) in force when the payout was recorded, so the
    // paid record renders its true historical breakdown even after the
    // platform changes the rates.
    mbankFeeBp: integer('mbank_fee_bp').notNull().default(300),
    cardFeeBp: integer('card_fee_bp').notNull().default(450),
    // Per-method snapshot of the online volume — one entry per payment method
    // that had orders, with the fee rate applied to it. Rows recorded before
    // payment methods became dynamic have null here; their breakdown is
    // reconstructed from the mbank/card columns above.
    breakdown: jsonb('breakdown').$type<SettlementMethodSnapshot[]>(),
    // Free-form payment reference (bank transfer id, bKash trx id, …).
    note: varchar('note', { length: 200 }),
    paidAt: timestamp('paid_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('settlements_shop_period_unique_idx').on(
      table.shopId,
      table.period,
    ),
    index('settlements_period_idx').on(table.period),
  ],
);

export const settlementsRelations = relations(settlements, ({ one }) => ({
  shop: one(shops, {
    fields: [settlements.shopId],
    references: [shops.id],
  }),
}));

export type SettlementRow = typeof settlements.$inferSelect;
export type NewSettlementRow = typeof settlements.$inferInsert;
