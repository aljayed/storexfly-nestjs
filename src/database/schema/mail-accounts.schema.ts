import {
  boolean,
  index,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

/**
 * Metadata for the staff mailboxes on the platform's own mail domain
 * (`someone@hoomri.com`), managed from the platform-admin console.
 *
 * This table is deliberately *not* the account store. The mailserver's own
 * `postfix-accounts.cf` is - it is what Dovecot authenticates against, and
 * duplicating it here would only create two truths about who has a mailbox.
 * What lives here is what the mailserver has no opinion about: whether an
 * operator may delete a box, and when it was made.
 *
 * The two are reconciled on every listing. An address in the file with no row
 * here gets one, locked: it was not created through this console - it came
 * with the server, or someone added it over SSH - so this console does not
 * get to remove it. That is what keeps the mailboxes the platform itself
 * depends on (`no-reply@`, `support@`, `contact@`) safe by default, without
 * anyone having to remember to protect them.
 */
export const mailAccounts = pgTable(
  'mail_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Full address, lowercased ('ops@hoomri.com'). */
    address: varchar('address', { length: 320 }).notNull(),
    /** Free-text note for the console - whose mailbox this is. */
    label: varchar('label', { length: 120 }),
    /**
     * A locked mailbox cannot be deleted from the console. Set on anything
     * that predates this feature or was added outside it; new boxes created
     * here are unlocked and removable.
     */
    locked: boolean('locked').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('mail_accounts_address_unique_idx').on(table.address),
    index('mail_accounts_locked_idx').on(table.locked),
  ],
);

export type MailAccountRow = typeof mailAccounts.$inferSelect;
export type NewMailAccountRow = typeof mailAccounts.$inferInsert;
