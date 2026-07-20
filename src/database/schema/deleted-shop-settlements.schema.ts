import {
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import type { SettlementMethodSnapshot } from './settlements.schema';
import type { PayoutBank } from './shops.schema';
import { users } from './users.schema';

/**
 * Money still owed to a shop that no longer exists. Deleting a shop cascades
 * away its orders and settlements, so any unpaid payout is snapshotted here
 * (one row per unsettled earnings month, current month included) inside the
 * same transaction as the delete. The platform operator pays these out from
 * the settlements console like any other month; `paidAt` records it.
 *
 * Everything is denormalized on purpose — the shop row is gone, so the name,
 * currency, owner contact and payout bank account must survive on their own.
 * `shopId` is a plain uuid (no FK) kept for traceability.
 */
export const deletedShopSettlements = pgTable(
  'deleted_shop_settlements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shopId: uuid('shop_id').notNull(),
    shopName: varchar('shop_name', { length: 160 }).notNull(),
    shopHandle: varchar('shop_handle', { length: 80 }).notNull(),
    currency: varchar('currency', { length: 3 }).notNull(),
    ownerId: uuid('owner_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    ownerEmail: varchar('owner_email', { length: 320 }),
    // Earnings month "YYYY-MM" this payout covers.
    period: varchar('period', { length: 7 }).notNull(),
    ordersCount: integer('orders_count').notNull(),
    totalCents: integer('total_cents').notNull(),
    feeCents: integer('fee_cents').notNull(),
    payoutCents: integer('payout_cents').notNull(),
    // Per-method snapshot of the online volume, same shape as settlements.
    breakdown: jsonb('breakdown').$type<SettlementMethodSnapshot[]>(),
    // The payout account on file when the shop was deleted.
    payoutBank: jsonb('payout_bank').$type<PayoutBank>(),
    owedAt: timestamp('owed_at', { withTimezone: true }).notNull().defaultNow(),
    // Set when the operator records the transfer; null = still owed.
    paidAt: timestamp('paid_at', { withTimezone: true }),
    note: varchar('note', { length: 200 }),
  },
  (table) => [
    index('deleted_shop_settlements_paid_idx').on(table.paidAt),
    index('deleted_shop_settlements_shop_idx').on(table.shopId),
  ],
);

export type DeletedShopSettlementRow =
  typeof deletedShopSettlements.$inferSelect;
export type NewDeletedShopSettlementRow =
  typeof deletedShopSettlements.$inferInsert;
