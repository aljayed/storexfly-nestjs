import { index, pgEnum, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { users } from './users.schema';

/**
 * Anti-abuse ledger: one row per signup or order attempt, used to answer "has
 * this person done this already in the last 12 hours?".
 *
 * Every identifier is stored as an HMAC rather than in the clear. Exact-match
 * lookups are all this table ever does, so it never needs to read a phone
 * number back - and a copy of it leaks nobody's contact details or browsing
 * addresses. The key lives in config; rotating it empties the history, which
 * is the intended trade.
 */
export const riskEventKindEnum = pgEnum('risk_event_kind', ['signup', 'order']);

export const riskEvents = pgTable(
  'risk_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: riskEventKindEnum('kind').notNull(),
    /** Normalised phone, hashed. Null when the attempt carried none. */
    phoneHash: varchar('phone_hash', { length: 64 }),
    emailHash: varchar('email_hash', { length: 64 }),
    ipHash: varchar('ip_hash', { length: 64 }),
    /** Client-supplied device fingerprint, hashed - a weak signal on its own,
     *  which is why it is only ever used together with the IP. */
    deviceHash: varchar('device_hash', { length: 64 }),
    /** Set when the attempt came from a signed-in account. */
    accountId: uuid('account_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Every lookup is "this identifier, this kind, since this time".
    index('risk_events_phone_idx').on(table.kind, table.phoneHash, table.createdAt),
    index('risk_events_email_idx').on(table.kind, table.emailHash, table.createdAt),
    index('risk_events_ip_idx').on(table.kind, table.ipHash, table.createdAt),
    index('risk_events_device_idx').on(table.kind, table.deviceHash, table.createdAt),
    // Drives the retention sweep.
    index('risk_events_created_idx').on(table.createdAt),
  ],
);

export type RiskEventKind = (typeof riskEventKindEnum.enumValues)[number];
export type RiskEventRow = typeof riskEvents.$inferSelect;
export type NewRiskEventRow = typeof riskEvents.$inferInsert;
