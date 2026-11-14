import { jsonb, pgTable, timestamp, varchar } from 'drizzle-orm/pg-core';

/**
 * The last good set of exchange rates, one row per base currency (only BDT
 * today). Kept in the database rather than only in memory so a restart - every
 * deploy is one - does not leave the storefront without rates until the next
 * successful fetch from the provider.
 *
 * `rates` maps a currency code to how many units of it one unit of `base`
 * buys, e.g. { "USD": 0.0082 } for base BDT.
 */
export const fxRates = pgTable('fx_rates', {
  base: varchar('base', { length: 3 }).primaryKey(),
  rates: jsonb('rates').$type<Record<string, number>>().notNull(),
  // Which provider this snapshot came from - for the logs, not for buyers.
  source: varchar('source', { length: 40 }).notNull(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
});

export type FxRatesRow = typeof fxRates.$inferSelect;
