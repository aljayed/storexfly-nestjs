import { relations } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import {
  platformPaymentMethodEnum,
  platformPaymentTypeEnum,
  subscriptionStatusEnum,
} from './enums';
import { coupons } from './coupons.schema';
import { shops } from './shops.schema';
import { users } from './users.schema';

/**
 * The platform subscription a seller pays per shop, monthly.
 * `nextBillingAt` is the billing anchor: it always advances exactly one
 * calendar month from the *scheduled* date, never from the date a late
 * payment was actually made. `startedAt`'s day-of-month is the anchor day.
 */
export const subscriptions = pgTable(
  'subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: subscriptionStatusEnum('status').notNull().default('active'),
    /**
     * Which rung of the plan ladder the shop is on right now
     * (`subscription_plans.code`). Kept as a code rather than an FK so a
     * retired plan can never orphan a live subscription.
     */
    planCode: varchar('plan_code', { length: 32 }).notNull().default('starter'),
    // Monthly fee in integer paisa (BDT cents), copied from the plan's price
    // when the subscription opens or changes plan, and re-priced with it.
    amountCents: integer('amount_cents').notNull().default(59900),
    currency: varchar('currency', { length: 3 }).notNull().default('BDT'),
    /**
     * A downgrade the seller picked, parked until the paid-up period ends —
     * they keep the plan they paid for until it expires. Cleared when applied
     * (or when they change their mind and pick another plan).
     */
    scheduledPlanCode: varchar('scheduled_plan_code', { length: 32 }),
    /**
     * When true, reaching 100% of the plan's sales cap moves the shop up one
     * rung automatically (charging the prorated difference) instead of
     * pausing it. Off by default — an upgrade costs money, so it is opt-in.
     */
    autoScale: boolean('auto_scale').notNull().default(false),
    /**
     * Pairs with `autoScale`: every billing date the plan drops back to the
     * entry rung and only that is charged, then auto-scale climbs again as
     * the month's sales come in — so a quiet month costs the entry price
     * rather than last month's peak. Meaningless (and forced off) without
     * auto-scale, which is what puts the shop back up.
     */
    autoReset: boolean('auto_reset').notNull().default(false),
    /**
     * When the shop's sales first passed the cap in the current period, with
     * auto-scale off. Starts the grace clock; cleared when the seller
     * upgrades or the period rolls over and the meter resets.
     */
    capExceededAt: timestamp('cap_exceeded_at', { withTimezone: true }),
    // When true the platform collects the renewal automatically on the due
    // date (dummy gateway). When false the sub goes past_due until the seller
    // pays manually from the console.
    autoDebit: boolean('auto_debit').notNull().default(true),
    // Coupon the seller applied from the console, discounting only the next
    // renewal. Consumed (cleared) when that renewal is collected; the code is
    // denormalized so the console can show it if the coupon is deleted.
    pendingCouponId: uuid('pending_coupon_id').references(() => coupons.id, {
      onDelete: 'set null',
    }),
    pendingCouponCode: varchar('pending_coupon_code', { length: 40 }),
    pendingDiscountCents: integer('pending_discount_cents')
      .notNull()
      .default(0),
    startedAt: timestamp('started_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    nextBillingAt: timestamp('next_billing_at', {
      withTimezone: true,
    }).notNull(),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('subscriptions_shop_unique_idx').on(table.shopId),
    index('subscriptions_status_billing_idx').on(
      table.status,
      table.nextBillingAt,
    ),
  ],
);

/**
 * Ledger of platform payments. `shop_creation` rows are paid before the shop
 * exists (a "credit" the create-shop call consumes — `consumedAt`/`shopId`
 * are filled in at that point). `renewal` rows cover one billing period
 * (`periodStart`..`periodEnd`) and record whether they were auto-debited or
 * paid manually after the due date. `upgrade` rows are the prorated
 * difference charged when a shop moves up the plan ladder mid-period —
 * `periodStart`..`periodEnd` is the remainder of the period they cover.
 */
export const subscriptionPayments = pgTable(
  'subscription_payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    subscriptionId: uuid('subscription_id').references(() => subscriptions.id, {
      onDelete: 'set null',
    }),
    shopId: uuid('shop_id').references(() => shops.id, {
      onDelete: 'set null',
    }),
    type: platformPaymentTypeEnum('type').notNull(),
    method: platformPaymentMethodEnum('method').notNull().default('manual'),
    /** Plan this payment bought, denormalized so the ledger stays readable. */
    planCode: varchar('plan_code', { length: 32 }),
    // The amount actually charged, after any coupon discount.
    amountCents: integer('amount_cents').notNull(),
    currency: varchar('currency', { length: 3 }).notNull().default('BDT'),
    // Coupon applied to this payment. The code is denormalized so the
    // ledger stays readable if the coupon is deleted.
    couponId: uuid('coupon_id').references(() => coupons.id, {
      onDelete: 'set null',
    }),
    couponCode: varchar('coupon_code', { length: 40 }),
    discountCents: integer('discount_cents').notNull().default(0),
    periodStart: timestamp('period_start', { withTimezone: true }),
    periodEnd: timestamp('period_end', { withTimezone: true }),
    paidAt: timestamp('paid_at', { withTimezone: true }).notNull().defaultNow(),
    // shop_creation only: when this credit was used to create a shop.
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (table) => [
    index('subscription_payments_user_idx').on(table.userId),
    index('subscription_payments_subscription_idx').on(table.subscriptionId),
  ],
);

export const subscriptionsRelations = relations(
  subscriptions,
  ({ one, many }) => ({
    shop: one(shops, {
      fields: [subscriptions.shopId],
      references: [shops.id],
    }),
    owner: one(users, {
      fields: [subscriptions.ownerId],
      references: [users.id],
    }),
    payments: many(subscriptionPayments),
  }),
);

export const subscriptionPaymentsRelations = relations(
  subscriptionPayments,
  ({ one }) => ({
    subscription: one(subscriptions, {
      fields: [subscriptionPayments.subscriptionId],
      references: [subscriptions.id],
    }),
    user: one(users, {
      fields: [subscriptionPayments.userId],
      references: [users.id],
    }),
    coupon: one(coupons, {
      fields: [subscriptionPayments.couponId],
      references: [coupons.id],
    }),
  }),
);

export type SubscriptionRow = typeof subscriptions.$inferSelect;
export type NewSubscriptionRow = typeof subscriptions.$inferInsert;
export type SubscriptionPaymentRow = typeof subscriptionPayments.$inferSelect;
export type NewSubscriptionPaymentRow =
  typeof subscriptionPayments.$inferInsert;
