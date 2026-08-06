import { relations } from 'drizzle-orm';
import {
  boolean,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { shops } from './shops.schema';

/**
 * Per-shop courier credentials - LEGACY, no longer read by anything.
 *
 * Couriers moved to a single platform-held merchant account (see the
 * `carrybee_*` / `steadfast_*` / `pathao_*` columns on `platform_settings`):
 * a shop booking parcels on its own courier account could keep the whole
 * fulfilment - and so the sales the platform bills on - off the books.
 *
 * The table is kept rather than dropped so an operator can still read what a
 * seller had entered; nothing writes to it and no booking path consults it.
 */
export const shopCouriers = pgTable(
  'shop_couriers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    provider: varchar('provider', { length: 20 }).notNull(),
    enabled: boolean('enabled').notNull().default(false),
    // Steadfast
    apiKey: text('api_key'),
    secretKey: text('secret_key'),
    // Pathao
    clientId: text('client_id'),
    clientSecret: text('client_secret'),
    username: text('username'),
    password: text('password'),
    storeId: varchar('store_id', { length: 40 }),
    sandbox: boolean('sandbox').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('shop_couriers_shop_provider_unique_idx').on(
      table.shopId,
      table.provider,
    ),
  ],
);

export const shopCouriersRelations = relations(shopCouriers, ({ one }) => ({
  shop: one(shops, {
    fields: [shopCouriers.shopId],
    references: [shops.id],
  }),
}));

export type ShopCourierRow = typeof shopCouriers.$inferSelect;
export type NewShopCourierRow = typeof shopCouriers.$inferInsert;
