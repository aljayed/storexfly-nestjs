import { relations } from 'drizzle-orm';
import {
  bigint,
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
  billingModeEnum,
  platformPaymentMethodEnum,
  platformPaymentTypeEnum,
  subscriptionStatusEnum,
} from './enums';
import { coupons } from './coupons.schema';
import { shops } from './shops.schema';
import { users } from './users.schema';

/**
 * How one shop pays the platform for the sales it makes. Every shop has
 * exactly one of these, and it carries whichever of the two tracks the shop
 * is on (see `common/constants/billing.ts`).
 *
 * **Credits.** `creditGrantedCents` is the running total of sales credit the
 * shop has ever bought. What it has *used* is not stored — it is the value of
 * the shop's non-cancelled orders since `meterStartAt`, so the balance is
 * `granted - used` and a cancelled order hands its allowance straight back
 * without anything having to un-write a counter. `creditExhaustedAt` marks
 * when the balance last hit zero, which is what paused the storefront.
 *
 * **Commission.** `nextBillingAt` is the billing anchor: it always advances
 * exactly one calendar month from the *scheduled* date, never from the date a
 * late payment was actually made, and `startedAt`'s day-of-month is the
 * anchor day. On each anchor the shop is billed `commissionBps` of what it
 * sold in the month just ended (less anything covered by leftover credit).
 * An unpaid bill sits in `dueCents` with `dueSince` starting the 25-day clock
 * the seller has to settle it by hand.
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
     * Which track the shop pays on. Every shop starts on 'credits';
     * 'commission' is only reachable once its trade licence is verified.
     */
    billingMode: billingModeEnum('billing_mode').notNull().default('credits'),
    currency: varchar('currency', { length: 3 }).notNull().default('BDT'),

    // ── Credits track ──────────────────────────────────────────────
    /** Every taka of sales credit this shop has ever bought, in paisa. */
    creditGrantedCents: bigint('credit_granted_cents', { mode: 'number' })
      .notNull()
      .default(0),
    /**
     * Orders placed from here on draw credit down and count towards the
     * commission bill. Set when the subscription opens, so sales a shop made
     * before this system existed never eat credit bought after it.
     */
    meterStartAt: timestamp('meter_start_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** When the balance last hit zero — what paused the storefront. */
    creditExhaustedAt: timestamp('credit_exhausted_at', { withTimezone: true }),

    // ── Commission track ───────────────────────────────────────────
    /** The shop's rate in basis points, snapshotted when it switches over. */
    commissionBps: integer('commission_bps').notNull().default(150),
    /** An issued monthly bill that has not been paid yet, in paisa. */
    dueCents: integer('due_cents').notNull().default(0),
    /** When that bill was issued — the start of the 25-day manual-pay clock. */
    dueSince: timestamp('due_since', { withTimezone: true }),
    /** The month the outstanding bill covers, for the console to name it. */
    duePeriodStart: timestamp('due_period_start', { withTimezone: true }),
    duePeriodEnd: timestamp('due_period_end', { withTimezone: true }),
    /**
     * The sales that outstanding bill was charged on. Recorded rather than
     * back-derived from the amount and the rate, because the operator can
     * change the rate between a bill being issued and it being paid.
     */
    dueBillableSalesCents: bigint('due_billable_sales_cents', {
      mode: 'number',
    }),

    // When true the platform collects the monthly commission automatically on
    // the due date (dummy gateway). When false the bill goes straight to
    // `dueCents` and the sub sits past_due until the seller pays by hand.
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
 * Ledger of platform payments — every taka a seller has paid the platform.
 *
 * `credit_pack` rows are a sales-credit purchase: `amountCents` is what the
 * seller paid, `salesCreditCents` is how much selling it bought, and
 * `planCode` names the pack. `commission` rows are one month's bill on a
 * verified shop: `periodStart`..`periodEnd` is the month, `billableSalesCents`
 * is the sales the rate was taken on, and `method` says whether it was
 * auto-debited on the due date or paid by hand afterwards.
 *
 * `shop_creation`, `renewal` and `upgrade` are the retired flat-fee and
 * plan-ladder types. Nothing writes them any more; they stay so a seller's
 * history from before the two-track model still reads.
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
    /**
     * The credit pack this payment bought, denormalized so the ledger stays
     * readable if the pack is re-priced or retired. (Named `plan_code` from
     * the plan-ladder era; retired rows still carry their plan here.)
     */
    planCode: varchar('plan_code', { length: 32 }),
    // The amount actually charged, after any coupon discount.
    amountCents: integer('amount_cents').notNull(),
    /** credit_pack only: how much selling this purchase paid for, in paisa. */
    salesCreditCents: bigint('sales_credit_cents', { mode: 'number' }),
    /** commission only: the sales the rate was charged on, in paisa. */
    billableSalesCents: bigint('billable_sales_cents', { mode: 'number' }),
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
    // Retired shop_creation rows only: when the credit was used to open a shop.
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
