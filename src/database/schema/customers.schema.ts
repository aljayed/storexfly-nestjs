import { relations } from 'drizzle-orm';
import {
  index,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { customerSegmentEnum } from './enums';
import { shops } from './shops.schema';
import { orders } from './orders.schema';

/**
 * A buyer who has ordered from a shop. Maps to `Customer` in the design
 * handoff. The lifetime aggregates (`orders`, `spentCents`, `first`, `last`,
 * `segment`) are recomputed server-side whenever an order lands - never
 * trusted from the client.
 */
export const customers = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 160 }).notNull(),
    email: varchar('email', { length: 320 }).notNull(),
    phone: varchar('phone', { length: 24 }).notNull().default(''),
    city: varchar('city', { length: 120 }).notNull().default(''),
    ordersCount: integer('orders_count').notNull().default(0),
    spentCents: integer('spent_cents').notNull().default(0),
    firstOrderAt: timestamp('first_order_at', { withTimezone: true }),
    lastOrderAt: timestamp('last_order_at', { withTimezone: true }),
    segment: customerSegmentEnum('segment').notNull().default('New'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('customers_shop_email_unique_idx').on(
      table.shopId,
      table.email,
    ),
    index('customers_shop_segment_idx').on(table.shopId, table.segment),
  ],
);

export const customersRelations = relations(customers, ({ one, many }) => ({
  shop: one(shops, {
    fields: [customers.shopId],
    references: [shops.id],
  }),
  orders: many(orders),
}));

export type CustomerRow = typeof customers.$inferSelect;
export type NewCustomerRow = typeof customers.$inferInsert;
