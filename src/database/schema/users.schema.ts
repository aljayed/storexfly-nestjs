import { relations } from 'drizzle-orm';
import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { authMethodEnum } from './enums';
import { shops } from './shops.schema';

/**
 * Platform accounts — sellers (and Google/phone buyers). Maps to `User` in the
 * design handoff. `passwordHash` is null for accounts that only ever used a
 * social/phone login.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 160 }).notNull(),
    email: varchar('email', { length: 320 }),
    phone: varchar('phone', { length: 24 }),
    passwordHash: text('password_hash'),
    via: authMethodEnum('via').notNull().default('email'),
    googleId: varchar('google_id', { length: 64 }),
    isAdmin: boolean('is_admin').notNull().default(false),
    emailVerified: boolean('email_verified').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('users_email_unique_idx').on(table.email),
    uniqueIndex('users_google_id_unique_idx').on(table.googleId),
    index('users_phone_idx').on(table.phone),
  ],
);

export const usersRelations = relations(users, ({ many }) => ({
  shops: many(shops),
}));

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
