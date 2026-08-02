import { relations } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { shops } from './shops.schema';
import { products } from './products.schema';

/**
 * A combo offer: two or more items from the same shop sold together at a
 * special price (below the summed member prices - the storefront shows the
 * savings). Members live in `combo_items`. Money in integer cents.
 */
export const combos = pgTable(
  'combos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 160 }).notNull(),
    blurb: text('blurb').notNull().default(''),
    emoji: varchar('emoji', { length: 16 }).notNull().default('🎁'),
    priceCents: integer('price_cents').notNull(),
    // Sellers can pause an offer without losing its setup.
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [index('combos_shop_idx').on(table.shopId)],
);

/** One member product of a combo, `qty` units of it per combo set. */
export const comboItems = pgTable(
  'combo_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    comboId: uuid('combo_id')
      .notNull()
      .references(() => combos.id, { onDelete: 'cascade' }),
    // Deleting a member product deletes the row - the combo then has fewer
    // than 2 members and the API stops exposing it to buyers.
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    qty: integer('qty').notNull().default(1),
  },
  (table) => [index('combo_items_combo_idx').on(table.comboId)],
);

export const combosRelations = relations(combos, ({ one, many }) => ({
  shop: one(shops, {
    fields: [combos.shopId],
    references: [shops.id],
  }),
  items: many(comboItems),
}));

export const comboItemsRelations = relations(comboItems, ({ one }) => ({
  combo: one(combos, {
    fields: [comboItems.comboId],
    references: [combos.id],
  }),
  product: one(products, {
    fields: [comboItems.productId],
    references: [products.id],
  }),
}));

export type ComboRow = typeof combos.$inferSelect;
export type NewComboRow = typeof combos.$inferInsert;
export type ComboItemRow = typeof comboItems.$inferSelect;
export type NewComboItemRow = typeof comboItems.$inferInsert;
