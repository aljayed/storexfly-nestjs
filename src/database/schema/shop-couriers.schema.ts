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

export const COURIER_PROVIDERS = ['steadfast', 'pathao'] as const;
export type CourierProvider = (typeof COURIER_PROVIDERS)[number];

/**
 * Per-shop courier credentials, one row per (shop, provider). Sellers manage
 * these from the console Settings page; secrets are write-only through the
 * API. At most one provider is `enabled` per shop — enabling one disables the
 * other — and a shop with no enabled row delivers manually.
 *
 * Column usage by provider:
 *  - steadfast: apiKey + secretKey
 *  - pathao:    clientId + clientSecret + username + password (+ storeId,
 *               required to book; sandbox switches the API base URL)
 */
export const shopCouriers = pgTable(
  'shop_couriers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    provider: varchar('provider', { length: 20 })
      .$type<CourierProvider>()
      .notNull(),
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
