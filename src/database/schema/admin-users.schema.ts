import { relations } from 'drizzle-orm';
import {
  boolean,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { adminRoleEnum } from './enums';
import { shops } from './shops.schema';

/**
 * A staff member of a shop's admin console. Independent from `users`: admin
 * sign-in is a separate, 2FA-protected flow that issues an admin-scoped JWT.
 * Maps to `AdminUser` in the design handoff.
 */
export const adminUsers = pgTable(
  'admin_users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 160 }).notNull(),
    email: varchar('email', { length: 320 }).notNull(),
    passwordHash: text('password_hash').notNull(),
    role: adminRoleEnum('role').notNull().default('staff'),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    twoFactorEnabled: boolean('two_factor_enabled').notNull().default(false),
    // Base32 TOTP secret (otplib). Null until 2FA is provisioned.
    twoFactorSecret: text('two_factor_secret'),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('admin_users_email_unique_idx').on(table.email),
  ],
);

export const adminUsersRelations = relations(adminUsers, ({ one }) => ({
  shop: one(shops, {
    fields: [adminUsers.shopId],
    references: [shops.id],
  }),
}));

export type AdminUserRow = typeof adminUsers.$inferSelect;
export type NewAdminUserRow = typeof adminUsers.$inferInsert;
