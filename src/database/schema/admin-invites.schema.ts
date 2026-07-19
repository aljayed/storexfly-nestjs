import { relations } from 'drizzle-orm';
import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { adminRoleEnum } from './enums';
import { adminUsers } from './admin-users.schema';
import { shops } from './shops.schema';

/**
 * A pending email invitation to a shop's admin console. The mailed link
 * carries a random token whose SHA-256 hash is stored here (never the token
 * itself); links are single-use and expire 24 hours after they are sent.
 * Re-inviting the same email refreshes the row (new token, expiry and role)
 * instead of stacking duplicates.
 */
export const adminInvites = pgTable(
  'admin_invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    email: varchar('email', { length: 320 }).notNull(),
    role: adminRoleEnum('role').notNull().default('staff'),
    tokenHash: text('token_hash').notNull(),
    // The staff member who sent the invite; kept for the "invited by" line in
    // the email/UI. Null if that admin account was later deleted.
    invitedById: uuid('invited_by_id').references(() => adminUsers.id, {
      onDelete: 'set null',
    }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('admin_invites_token_hash_unique_idx').on(table.tokenHash),
    uniqueIndex('admin_invites_shop_email_unique_idx').on(
      table.shopId,
      table.email,
    ),
    index('admin_invites_shop_idx').on(table.shopId),
  ],
);

export const adminInvitesRelations = relations(adminInvites, ({ one }) => ({
  shop: one(shops, {
    fields: [adminInvites.shopId],
    references: [shops.id],
  }),
  invitedBy: one(adminUsers, {
    fields: [adminInvites.invitedById],
    references: [adminUsers.id],
  }),
}));

export type AdminInviteRow = typeof adminInvites.$inferSelect;
export type NewAdminInviteRow = typeof adminInvites.$inferInsert;
