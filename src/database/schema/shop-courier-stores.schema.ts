import { relations } from 'drizzle-orm';
import {
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { shops } from './shops.schema';

/**
 * The courier pickup store registered for one shop, on the platform's account.
 *
 * A marketplace ships from as many addresses as it has sellers, so a single
 * platform-wide pickup store would have every parcel collected from one door.
 * Instead each shop gets its own store under the operator's courier account,
 * registered on first booking from the shop's `pickup*` address, and the id
 * the courier hands back is cached here.
 *
 * Credentials stay platform-held - this is only the pickup point, not an
 * account a seller could book around. One row per (shop, provider): a shop
 * that has shipped on Pathao and later moves to CarryBee keeps both, so
 * switching back does not re-register a store that already exists.
 */
export const shopCourierStores = pgTable(
  'shop_courier_stores',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    provider: varchar('provider', { length: 20 }).notNull(),
    /** The courier's own store id, used as `store_id` when booking. */
    storeId: varchar('store_id', { length: 64 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('shop_courier_stores_shop_provider_idx').on(
      table.shopId,
      table.provider,
    ),
  ],
);

export const shopCourierStoresRelations = relations(
  shopCourierStores,
  ({ one }) => ({
    shop: one(shops, {
      fields: [shopCourierStores.shopId],
      references: [shops.id],
    }),
  }),
);

export type ShopCourierStoreRow = typeof shopCourierStores.$inferSelect;
export type NewShopCourierStoreRow = typeof shopCourierStores.$inferInsert;
