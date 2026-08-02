import { relations } from 'drizzle-orm';
import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { users } from './users.schema';
import { orders } from './orders.schema';
import { shops } from './shops.schema';

/**
 * In-app notifications shown on the buyer's profile - order placed, status
 * changes, payment confirmations, refunds. Orders are matched to a buyer at
 * emit time (by the order's email or phone), so guest orders that later get
 * claimed still notify from the claim onward.
 */
export const buyerNotifications = pgTable(
  'buyer_notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    buyerId: uuid('buyer_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id').references(() => orders.id, {
      onDelete: 'set null',
    }),
    shopId: uuid('shop_id').references(() => shops.id, {
      onDelete: 'set null',
    }),
    type: varchar('type', { length: 30 }).notNull(),
    title: varchar('title', { length: 160 }).notNull(),
    body: text('body').notNull(),
    // Denormalized so the list renders without joins even if the order goes.
    orderReference: varchar('order_reference', { length: 16 }),
    shopName: varchar('shop_name', { length: 160 }),
    shopHandle: varchar('shop_handle', { length: 80 }),
    read: boolean('read').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('buyer_notifications_buyer_idx').on(
      table.buyerId,
      table.read,
      table.createdAt,
    ),
  ],
);

export const buyerNotificationsRelations = relations(
  buyerNotifications,
  ({ one }) => ({
    buyer: one(users, {
      fields: [buyerNotifications.buyerId],
      references: [users.id],
    }),
    order: one(orders, {
      fields: [buyerNotifications.orderId],
      references: [orders.id],
    }),
  }),
);

export type BuyerNotificationRow = typeof buyerNotifications.$inferSelect;
export type NewBuyerNotificationRow = typeof buyerNotifications.$inferInsert;
