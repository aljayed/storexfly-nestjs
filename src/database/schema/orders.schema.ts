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
  paymentStatusEnum,
  salesChannelEnum,
} from './enums';
import { shops } from './shops.schema';
import { customers } from './customers.schema';
import { users } from './users.schema';
import { products } from './products.schema';
import { orderAmountAdjustments } from './order-amount-adjustments.schema';

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
    /**
     * The account that placed this, when one was signed in - or was linked to
     * it afterwards by claiming. Null for a genuine guest checkout.
     *
     * This is what "my orders" means. It used to be answered by matching the
     * email stored below, which quietly made an email address the buyer's
     * identity: changing it lost their order history, their verified-purchase
     * reviews and their chat threads in one go. The email stays as a record of
     * what they typed at checkout; who they *are* is this.
     */
    userId: uuid('user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    customerName: varchar('customer_name', { length: 160 }).notNull(),
    email: varchar('email', { length: 320 }).notNull(),
    phone: varchar('phone', { length: 24 }),
    qty: integer('qty').notNull(),
    totalCents: integer('total_cents').notNull(),
    // Delivery charge included in `totalCents` (also present as a line item).
    deliveryCents: integer('delivery_cents').notNull().default(0),
    status: orderStatusEnum('status').notNull().default('New'),
    pay: paymentStatusEnum('pay').notNull().default('Paid'),
    // Code of the `payment_methods` row the buyer paid with ('cod', 'mbank',
    // an operator-added slug, …); null for orders recorded manually.
    paymentMethod: varchar('payment_method', { length: 40 }),
    mobileBankApp: mobileBankAppEnum('mobile_bank_app'),
    // The part of this order intentionally paid before delivery. Zero means a
    // normal full-payment or full-COD order. `advancePaidAt` distinguishes a
    // requested direct transfer from one the seller has actually confirmed.
    advanceCents: integer('advance_cents').notNull().default(0),
    advancePaidAt: timestamp('advance_paid_at', { withTimezone: true }),
    channel: salesChannelEnum('channel').notNull().default('Store'),
    address: jsonb('address').$type<DeliveryAddressValue>(),
    // ── Shop coupon the buyer redeemed (null = none) ───────────────
    // The code is copied in so the order still reads correctly after the
    // coupon is edited or deleted; `discountCents` is already subtracted
    // from `totalCents` and also appears as a negative line item.
    couponCode: varchar('coupon_code', { length: 40 }),
    discountCents: integer('discount_cents').notNull().default(0),
    // ── Courier consignment (set when the seller books) ────────────
    // Which provider booked it ('carrybee' | 'steadfast' | 'pathao'); null on
    // legacy rows booked before the provider was recorded, which were all
    // Steadfast. Bookings run on the platform's own courier account.
    courierProvider: varchar('courier_provider', { length: 20 }),
    courierConsignmentId: varchar('courier_consignment_id', { length: 64 }),
    courierTrackingCode: varchar('courier_tracking_code', { length: 64 }),
    // Raw delivery status from the provider ('pending', 'delivered', …).
    courierStatus: varchar('courier_status', { length: 40 }),
    // When the provider stamped that status. Webhooks can arrive out of
    // order, so an event older than what's stored is dropped rather than
    // rolling the order backwards.
    courierStatusAt: timestamp('courier_status_at', { withTimezone: true }),
    // What the courier quoted and what it actually collected at the door.
    // `courierCollectedCents` is the figure a COD settlement should trust -
    // a partial delivery collects less than the order total.
    courierDeliveryFeeCents: integer('courier_delivery_fee_cents'),
    courierCodFeeCents: integer('courier_cod_fee_cents'),
    courierCollectedCents: integer('courier_collected_cents'),
    // Why the parcel came back, straight from the courier ('customer refused',
    // …). Set on a return/failed delivery so the seller sees the reason.
    courierFailureReason: varchar('courier_failure_reason', { length: 255 }),
    // When the seller physically handed the parcel over - the moment the
    // order stops being theirs to advance.
    handedOverAt: timestamp('handed_over_at', { withTimezone: true }),
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
    index('orders_user_idx').on(table.userId, table.placedAt),
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
    // Physical units this line took out of stock. Differs from `qty` whenever
    // a multi-buy pack is involved - qty counts picks ("2 × Pack of 3"), this
    // counts the 6 units that actually left the shelf, which is what a
    // cancellation has to give back. Null on rows written before this column;
    // the restock path falls back to `qty` for those.
    units: integer('units'),
    unitPriceCents: integer('unit_price_cents').notNull(),
    // Human-readable snapshot of what was picked at purchase time
    // ("Size: L · Red · Pack of 3") - survives later catalog edits.
    variant: varchar('variant', { length: 240 }),
    // Machine-readable twin of `variant`: the picked `{ groupId: optionId }`
    // map. Only options that track their own stock need it - cancelling an
    // order has to know *which* choice to hand the units back to. Null for
    // lines with no variants (and for orders placed before this column).
    variantPick: jsonb('variant_pick').$type<Record<string, string>>(),
    // Stable id of the exact combination whose stock was moved. Null marks a
    // legacy per-option order, so later catalog migrations cannot restock the
    // wrong inventory model on cancellation.
    variantCombinationId: varchar('variant_combination_id', { length: 24 }),
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
  adjustments: many(orderAmountAdjustments),
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
