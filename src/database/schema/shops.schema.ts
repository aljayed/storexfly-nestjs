import { relations } from 'drizzle-orm';
import {
  boolean,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { brandSwatchEnum, shopCategoryEnum } from './enums';
import { users } from './users.schema';
import { products } from './products.schema';
import { orders } from './orders.schema';
import { customers } from './customers.schema';
import { adminUsers } from './admin-users.schema';

/**
 * A seller's branded storefront, reachable at storexfly.com/shops/<handle>.
 * Maps to `Shop` in the design handoff. `brand`/`brandSoft` are the resolved
 * hex values for the chosen swatch and drive the per-shop CSS custom props.
 */
export const shops = pgTable(
  'shops',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 160 }).notNull(),
    handle: varchar('handle', { length: 80 }).notNull(),
    tagline: varchar('tagline', { length: 240 }),
    cat: shopCategoryEnum('cat').notNull().default('Other'),
    // ISO 4217 currency code the shop prices in (see SUPPORTED_CURRENCIES).
    currency: varchar('currency', { length: 3 }).notNull().default('BDT'),
    brandId: brandSwatchEnum('brand_id').notNull().default('amber'),
    brand: varchar('brand', { length: 9 }).notNull(),
    brandSoft: varchar('brand_soft', { length: 9 }).notNull(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Buyer-facing on/off switch. When false the public storefront, catalog
    // and checkout endpoints all refuse to serve the shop. Forced off when
    // the platform subscription is cancelled.
    live: boolean('live').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [uniqueIndex('shops_handle_unique_idx').on(table.handle)],
);

export const shopsRelations = relations(shops, ({ one, many }) => ({
  owner: one(users, {
    fields: [shops.ownerId],
    references: [users.id],
  }),
  products: many(products),
  orders: many(orders),
  customers: many(customers),
  admins: many(adminUsers),
}));

export type ShopRow = typeof shops.$inferSelect;
export type NewShopRow = typeof shops.$inferInsert;
