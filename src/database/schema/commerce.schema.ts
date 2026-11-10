import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  boolean,
} from 'drizzle-orm/pg-core';
import { products } from './products.schema';
import { shops } from './shops.schema';
import { users } from './users.schema';
import { orders } from './orders.schema';

/** A derived offer, never an independent inventory record. */
export const resellerListings = pgTable(
  'reseller_listings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'restrict' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    sellingPriceCents: integer('selling_price_cents').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('reseller_listings_shop_product_idx').on(t.shopId, t.productId),
  ],
);
export const tradeQuotes = pgTable(
  'trade_quotes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    buyerId: uuid('buyer_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'restrict' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    kind: varchar('kind', { length: 16 })
      .$type<'bulk' | 'sample'>()
      .notNull()
      .default('bulk'),
    qty: integer('qty').notNull(),
    variant: jsonb('variant')
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    message: text('message').notNull(),
    status: varchar('status', { length: 16 })
      .$type<'requested' | 'quoted' | 'accepted' | 'declined' | 'cancelled'>()
      .notNull()
      .default('requested'),
    unitPriceCents: integer('unit_price_cents'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('trade_quotes_buyer_idx').on(t.buyerId, t.createdAt),
    index('trade_quotes_supplier_idx').on(t.shopId, t.createdAt),
  ],
);
export const tradeMessages = pgTable('trade_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  quoteId: uuid('quote_id')
    .notNull()
    .references(() => tradeQuotes.id, { onDelete: 'cascade' }),
  sender: varchar('sender', { length: 16 })
    .$type<'buyer' | 'supplier'>()
    .notNull(),
  text: text('text').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const tradeDisputes = pgTable(
  'trade_disputes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    buyerId: uuid('buyer_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'restrict' }),
    reason: text('reason').notNull(),
    status: varchar('status', { length: 16 })
      .$type<'open' | 'proposed' | 'escalated' | 'resolved'>()
      .notNull()
      .default('open'),
    resolution: text('resolution'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('trade_disputes_order_idx').on(t.orderId)],
);
