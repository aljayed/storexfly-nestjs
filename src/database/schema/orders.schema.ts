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
import {
  mobileBankAppEnum,
  orderStatusEnum,
  paymentMethodEnum,
  paymentStatusEnum,
  salesChannelEnum,
} from './enums';
import { shops } from './shops.schema';
import { customers } from './customers.schema';
import { products } from './products.schema';

/** Shape of the embedded delivery address (maps to `DeliveryAddress`). */
export interface DeliveryAddressValue {
  line: string;
  area: string;
  pincode: string;
  geo?: { lat: number; lng: number } | { x: number; y: number };
}

/**
 * A buyer order. Maps to `Order` in the design handoff. `reference` is the
 * human-facing id (e.g. "#1042"); the surrogate `id` is the real PK. Money in
 * integer cents. The delivery address is embedded as JSON since it is captured
 * once at checkout and never queried relationally.
 */
export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reference: varchar('reference', { length: 16 }).notNull(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id').references(() => customers.id, {
      onDelete: 'set null',
    }),
    customerName: varchar('customer_name', { length: 160 }).notNull(),
    email: varchar('email', { length: 320 }).notNull(),
    phone: varchar('phone', { length: 24 }),
    qty: integer('qty').notNull(),
    totalCents: integer('total_cents').notNull(),
    status: orderStatusEnum('status').notNull().default('New'),
    pay: paymentStatusEnum('pay').notNull().default('Paid'),
    paymentMethod: paymentMethodEnum('payment_method'),
    mobileBankApp: mobileBankAppEnum('mobile_bank_app'),
    channel: salesChannelEnum('channel').notNull().default('Store'),
    address: jsonb('address').$type<DeliveryAddressValue>(),
    placedAt: timestamp('placed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('orders_shop_reference_unique_idx').on(
      table.shopId,
      table.reference,
    ),
    index('orders_shop_status_idx').on(table.shopId, table.status),
    index('orders_shop_channel_idx').on(table.shopId, table.channel),
    index('orders_customer_idx').on(table.customerId),
  ],
);

/**
 * A normalized line item of an order. The denormalized `name`/`unitPriceCents`
 * preserve the product as it was at purchase time even if the catalog changes.
 */
export const orderItems = pgTable(
  'order_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    productId: uuid('product_id').references(() => products.id, {
      onDelete: 'set null',
    }),
    name: varchar('name', { length: 200 }).notNull(),
    qty: integer('qty').notNull(),
    unitPriceCents: integer('unit_price_cents').notNull(),
  },
  (table) => [index('order_items_order_idx').on(table.orderId)],
);

export const ordersRelations = relations(orders, ({ one, many }) => ({
  shop: one(shops, {
    fields: [orders.shopId],
    references: [shops.id],
  }),
  customer: one(customers, {
    fields: [orders.customerId],
    references: [customers.id],
  }),
  items: many(orderItems),
}));

export const orderItemsRelations = relations(orderItems, ({ one }) => ({
  order: one(orders, {
    fields: [orderItems.orderId],
    references: [orders.id],
  }),
  product: one(products, {
    fields: [orderItems.productId],
    references: [products.id],
  }),
}));

export type OrderRow = typeof orders.$inferSelect;
export type NewOrderRow = typeof orders.$inferInsert;
export type OrderItemRow = typeof orderItems.$inferSelect;
export type NewOrderItemRow = typeof orderItems.$inferInsert;
