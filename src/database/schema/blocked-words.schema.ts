import {
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

/**
 * Words/phrases rejected in shop names, shop handles, and seller/buyer
 * display names — profanity plus brand-protection terms (e.g. "hoomri", so
 * nobody can name a shop after the platform itself). Managed from the
 * platform-admin console; matched case-insensitively as a substring.
 */
export const blockedWords = pgTable(
  'blocked_words',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Stored lowercase/trimmed; matching lowercases the input too.
    word: varchar('word', { length: 80 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex('blocked_words_word_unique_idx').on(table.word)],
);

export type BlockedWordRow = typeof blockedWords.$inferSelect;
export type NewBlockedWordRow = typeof blockedWords.$inferInsert;
