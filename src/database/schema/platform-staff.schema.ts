import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import type { PlatformGrants } from '../../common/auth/platform-access';

/**
 * A role in the platform console: a named set of workspace grants. The
 * starting set is seeded by migration 0120; `system` roles can be re-granted
 * but not deleted, and `owner` cannot be changed at all.
 */
export const platformRoles = pgTable('platform_roles', {
  key: varchar('key', { length: 40 }).primaryKey(),
  name: varchar('name', { length: 80 }).notNull(),
  description: varchar('description', { length: 300 }),
  grants: jsonb('grants').$type<PlatformGrants>().notNull().default({}),
  system: boolean('system').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/**
 * One person who works in the platform console. Each has their own login and
 * a required authenticator-app code. The platform owner's row is created on
 * their first sign-in with the PLATFORM_ADMIN_* credentials; its password
 * stays in the environment (`passwordHash` null) so it can never be lost.
 */
export const platformStaff = pgTable(
  'platform_staff',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 160 }).notNull(),
    email: varchar('email', { length: 320 }).notNull(),
    passwordHash: text('password_hash'),
    roleKey: varchar('role_key', { length: 40 })
      .notNull()
      .references(() => platformRoles.key, { onUpdate: 'cascade' }),
    status: varchar('status', { length: 16 })
      .$type<'active' | 'suspended'>()
      .notNull()
      .default('active'),
    // The initial password was set by someone else; replace it at next sign-in.
    mustChangePassword: boolean('must_change_password').notNull().default(true),
    twoFactorEnabled: boolean('two_factor_enabled').notNull().default(false),
    twoFactorSecret: text('two_factor_secret'),
    // Bumped to sign the person out everywhere (suspend, reset, role change).
    sessionVersion: integer('session_version').notNull().default(1),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex('platform_staff_email_idx').on(t.email)],
);

/**
 * Append-only record of every change made through the platform console.
 * A database trigger refuses UPDATE and DELETE on this table.
 */
export const platformAuditLog = pgTable(
  'platform_audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorId: uuid('actor_id'),
    actorName: varchar('actor_name', { length: 160 }),
    actorEmail: varchar('actor_email', { length: 320 }),
    actorRole: varchar('actor_role', { length: 80 }),
    workspace: varchar('workspace', { length: 20 }),
    action: varchar('action', { length: 120 }).notNull(),
    method: varchar('method', { length: 8 }),
    path: varchar('path', { length: 300 }),
    targetId: varchar('target_id', { length: 120 }),
    outcome: varchar('outcome', { length: 16 })
      .$type<'ok' | 'failed' | 'denied'>()
      .notNull()
      .default('ok'),
    statusCode: integer('status_code'),
    details: jsonb('details').$type<Record<string, unknown>>(),
    ip: varchar('ip', { length: 64 }),
    userAgent: varchar('user_agent', { length: 300 }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('platform_audit_created_idx').on(t.createdAt),
    index('platform_audit_actor_idx').on(t.actorId, t.createdAt),
    index('platform_audit_workspace_idx').on(t.workspace, t.createdAt),
  ],
);

export type PlatformRoleRow = typeof platformRoles.$inferSelect;
export type PlatformStaffRow = typeof platformStaff.$inferSelect;
export type PlatformAuditRow = typeof platformAuditLog.$inferSelect;
