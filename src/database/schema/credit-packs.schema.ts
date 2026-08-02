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
 * The credit packs a seller on the pre-paid track buys. A pack pays for
 * `salesCreditCents` worth of *selling*, and costs `priceCents` — bigger
 * packs carry a better rate, which is the only reason to buy one.
 *
 * Seeded from `CREDIT_PACKS`; the operator can re-price a pack or retire it
 * from the platform console without a deploy, so the rows (not the constants)
 * are the live catalogue. `sortOrder` is shelf order, cheapest first.
 */
export const creditPacks = pgTable(
  'credit_packs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Stable identifier recorded on purchases ('credit-100k', …). */
    code: varchar('code', { length: 32 }).notNull(),
    name: varchar('name', { length: 60 }).notNull(),
    /** How much selling this pack pays for, in paisa. */
    salesCreditCents: bigint('sales_credit_cents', {
      mode: 'number',
    }).notNull(),
    /** What the pack costs, in paisa. */
    priceCents: integer('price_cents').notNull(),
    /** Optional shelf label ('Most popular') shown on the pack card. */
    badge: varchar('badge', { length: 40 }),
    sortOrder: integer('sort_order').notNull().default(0),
    /** A retired pack stays readable on past purchases, but is not sold. */
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
    uniqueIndex('credit_packs_code_unique_idx').on(table.code),
    index('credit_packs_sort_idx').on(table.sortOrder),
  ],
);

export type CreditPackRow = typeof creditPacks.$inferSelect;
export type NewCreditPackRow = typeof creditPacks.$inferInsert;
