import { relations } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { combos } from './combos.schema';
import { orders } from './orders.schema';
import { products } from './products.schema';
import { shops } from './shops.schema';

/**
 * What a coupon may be spent on:
 *  - `all`     - every sale item in the order. Showcase items are advertised
 *                only and never reach checkout, so they are excluded by
 *                construction (see `OrdersService.priceProductPick`).
 *  - `product` - one specific product; only that product's lines discount.
 *  - `combo`   - one specific combo offer; only a checkout of that combo.
 */
export const shopCouponScopeEnum = pgEnum('shop_coupon_scope', [
  'all',
  'product',
  'combo',
]);

/** Percentage off, or a flat taka amount off (stored in integer cents). */
export const shopCouponTypeEnum = pgEnum('shop_coupon_type', [
  'percent',
  'fixed',
]);

/**
 * Buyer-facing discount codes owned by a shop and created by its admins.
 *
 * Distinct from the platform `coupons` table, which discounts a seller's
 * *subscription* payments and is managed from the platform console. These
 * discount a buyer's storefront order and never touch billing.
 *
 * The discount always applies to the item subtotal - never to delivery, so a
 * coupon can't erode the courier charge the seller has to pay. Codes are
 * stored uppercase and matched case-insensitively, and are unique per shop
 * (two different shops may both run "EID25").
 */
export const shopCoupons = pgTable(
  'shop_coupons',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    code: varchar('code', { length: 40 }).notNull(),
    description: varchar('description', { length: 200 }),

    discountType: shopCouponTypeEnum('discount_type')
      .notNull()
      .default('percent'),
    /** percent → whole-number 1..100; fixed → discount in cents. */
    value: integer('value').notNull(),
    /** Ceiling for a percentage coupon, in cents; null = uncapped. */
    maxDiscountCents: integer('max_discount_cents'),
    /** Minimum item subtotal before the code is accepted (0 = no minimum). */
    minOrderCents: integer('min_order_cents').notNull().default(0),

    scope: shopCouponScopeEnum('scope').notNull().default('all'),
    // Set only for the matching scope. Deleting the target deletes the coupon:
    // a code that can no longer discount anything is dead weight.
    productId: uuid('product_id').references(() => products.id, {
      onDelete: 'cascade',
    }),
    comboId: uuid('combo_id').references(() => combos.id, {
      onDelete: 'cascade',
    }),

    active: boolean('active').notNull().default(true),
    /** Optional window; null start = live immediately, null end = no expiry. */
    startsAt: timestamp('starts_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),

    /** Global redemption cap; null = unlimited. */
    maxRedemptions: integer('max_redemptions'),
    redemptions: integer('redemptions').notNull().default(0),
    /** Per-buyer cap, counted by phone number; null = unlimited. */
    perCustomerLimit: integer('per_customer_limit'),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('shop_coupons_shop_code_unique_idx').on(
      table.shopId,
      table.code,
    ),
    index('shop_coupons_shop_idx').on(table.shopId),
  ],
);

/**
 * One accepted use of a coupon. Written inside the checkout transaction so the
 * global and per-buyer caps are enforced against committed rows only.
 *
 * Buyers can check out as guests, so the identity here is the normalized
 * national phone number (same rule the notifications matcher uses) rather than
 * a customer id - that is what a shopper actually re-uses across orders.
 * Cancelling an order (including a gateway payment that never completed)
 * releases its redemption again.
 */
export const shopCouponRedemptions = pgTable(
  'shop_coupon_redemptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    couponId: uuid('coupon_id')
      .notNull()
      .references(() => shopCoupons.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    /** Digits only, no country code - e.g. "1712345678". */
    phone: varchar('phone', { length: 24 }).notNull(),
    discountCents: integer('discount_cents').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('shop_coupon_redemptions_coupon_phone_idx').on(
      table.couponId,
      table.phone,
    ),
    uniqueIndex('shop_coupon_redemptions_order_unique_idx').on(table.orderId),
  ],
);

export const shopCouponsRelations = relations(shopCoupons, ({ one, many }) => ({
  shop: one(shops, {
    fields: [shopCoupons.shopId],
    references: [shops.id],
  }),
  product: one(products, {
    fields: [shopCoupons.productId],
    references: [products.id],
  }),
  combo: one(combos, {
    fields: [shopCoupons.comboId],
    references: [combos.id],
  }),
  redemptionRows: many(shopCouponRedemptions),
}));

export const shopCouponRedemptionsRelations = relations(
  shopCouponRedemptions,
  ({ one }) => ({
    coupon: one(shopCoupons, {
      fields: [shopCouponRedemptions.couponId],
      references: [shopCoupons.id],
    }),
    order: one(orders, {
      fields: [shopCouponRedemptions.orderId],
      references: [orders.id],
    }),
  }),
);

export type ShopCouponRow = typeof shopCoupons.$inferSelect;
export type NewShopCouponRow = typeof shopCoupons.$inferInsert;
export type ShopCouponRedemptionRow = typeof shopCouponRedemptions.$inferSelect;
