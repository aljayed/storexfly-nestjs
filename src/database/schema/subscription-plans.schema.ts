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

/**
 * The plan ladder sellers subscribe to — five tiers priced by how much a shop
 * sells in a billing period. Seeded from `PLAN_TIERS`; the operator can
 * re-price a tier or move its cap from the platform console without a deploy,
 * so the rows (not the constants) are the live catalog.
 *
 * `sortOrder` is the ladder order: auto-scale moves a shop to the next row up
 * when its period sales reach the current row's cap. The top row has a null
 * `salesCapCents` — uncapped selling — and is where the ladder stops.
 */
export const subscriptionPlans = pgTable(
  'subscription_plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Stable identifier stored on subscriptions ('starter', 'growth', …). */
    code: varchar('code', { length: 32 }).notNull(),
    name: varchar('name', { length: 60 }).notNull(),
    /** Monthly sales ceiling in paisa; null = uncapped (top tier). */
    salesCapCents: bigint('sales_cap_cents', { mode: 'number' }),
    /** Monthly price in paisa. */
    priceCents: integer('price_cents').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    /** A retired tier stays readable for shops still on it, but is not sold. */
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('subscription_plans_code_unique_idx').on(table.code),
    index('subscription_plans_sort_idx').on(table.sortOrder),
  ],
);

export type SubscriptionPlanRow = typeof subscriptionPlans.$inferSelect;
export type NewSubscriptionPlanRow = typeof subscriptionPlans.$inferInsert;
