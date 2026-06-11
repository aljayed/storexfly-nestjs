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
import { shops } from './shops.schema';
import { users } from './users.schema';

/**
 * The platform subscription a seller pays per shop (৳1,199 / month).
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
    // Monthly fee in integer paisa (BDT cents) — ৳1,199.00.
    amountCents: integer('amount_cents').notNull().default(119900),
    currency: varchar('currency', { length: 3 }).notNull().default('BDT'),
    // When true the platform collects the renewal automatically on the due
    // date (dummy gateway). When false the sub goes past_due until the seller
    // pays manually from the console.
    autoDebit: boolean('auto_debit').notNull().default(true),
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
 * paid manually after the due date.
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
    amountCents: integer('amount_cents').notNull(),
    currency: varchar('currency', { length: 3 }).notNull().default('BDT'),
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
  }),
);

export type SubscriptionRow = typeof subscriptions.$inferSelect;
export type NewSubscriptionRow = typeof subscriptions.$inferInsert;
export type SubscriptionPaymentRow = typeof subscriptionPayments.$inferSelect;
export type NewSubscriptionPaymentRow =
  typeof subscriptionPayments.$inferInsert;
