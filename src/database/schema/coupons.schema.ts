import { relations } from 'drizzle-orm';
import {
  boolean,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { subscriptionPayments } from './subscriptions.schema';

/**
 * Platform-level discount coupons, managed from the platform admin console.
 * A coupon discounts one subscription payment - the one-off shop-creation fee
 * or, applied from the shop console, a subscription's next renewal - and each
 * seller can redeem a given code once. Codes are stored uppercase and matched
 * case-insensitively.
 */
export const coupons = pgTable(
  'coupons',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: varchar('code', { length: 40 }).notNull(),
    description: varchar('description', { length: 200 }),
    // Whole-number percentage discount, 1..100.
    percentOff: integer('percent_off').notNull(),
    active: boolean('active').notNull().default(true),
    // Optional global redemption cap; null = unlimited.
    maxRedemptions: integer('max_redemptions'),
    redemptions: integer('redemptions').notNull().default(0),
    // Optional expiry; null = never expires.
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [uniqueIndex('coupons_code_unique_idx').on(table.code)],
);

export const couponsRelations = relations(coupons, ({ many }) => ({
  payments: many(subscriptionPayments),
}));

export type CouponRow = typeof coupons.$inferSelect;
export type NewCouponRow = typeof coupons.$inferInsert;
