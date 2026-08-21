import { relations } from 'drizzle-orm';
import {
  boolean,
  index,
  jsonb,
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
 * A pinned map location the account saved at checkout. `line`/`area`/`pin` are
 * the human-readable address for the drop. `lat`/`lng` are the exact coordinates
 * from the interactive delivery map. `x`/`y` are the legacy canvas pin position
 * (percent) kept for pins saved before the real map - all optional so either
 * representation validates.
 */
export interface BuyerGeoValue {
  line: string;
  area: string;
  pin: string;
  /** Raw district label from the reverse geocoder (e.g. "Dhaka District"). */
  district?: string;
  /** Complete reverse-geocoded address line shown under the delivery map. */
  full?: string;
  lat?: number;
  lng?: number;
  x?: number;
  y?: number;
}

/**
 * Platform accounts - the single human identity for both shopping and selling.
 * Anyone can buy; you become a seller by owning a shop.
 *
 * Identity is `id`/`publicId`, never the email. Email, phone and handle are
 * all things a person may change, and everything that has to survive those
 * changes - orders, reviews, chat threads - points at the account itself. `passwordHash` is null
 * for accounts that only ever used a social/phone login. The `address*`/`geo`/
 * `lastPayMethod`/`phoneVerified` fields are the storefront-shopper profile
 * (saved checkout autofill), folded in when buyer & seller accounts unified.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * The account's permanent public identity - "HM7K3PQR9X".
     *
     * Everything else a person is known by can change: they can move email,
     * change phone, take a new username. This cannot, and nothing is keyed on
     * it changing, so it is what a support conversation quotes and what the
     * account is still recognisably itself by afterwards. Assigned at signup
     * and never reissued.
     */
    publicId: varchar('public_id', { length: 16 }).notNull(),
    name: varchar('name', { length: 160 }).notNull(),
    email: varchar('email', { length: 320 }),
    phone: varchar('phone', { length: 24 }),
    passwordHash: text('password_hash'),
    via: authMethodEnum('via').notNull().default('email'),
    googleId: varchar('google_id', { length: 64 }),
    isAdmin: boolean('is_admin').notNull().default(false),
    /**
     * Public username, claimed from the profile page - "@rafiq" rather than an
     * email address. It is what other people can find an account by, which is
     * the point: an address book of emails should never be searchable, but a
     * handle is only discoverable because its owner chose to publish it.
     *
     * Null until claimed, stored lowercase, and only settable once the email
     * is verified (see BuyerService.setHandle).
     */
    handle: varchar('handle', { length: 24 }),
    /**
     * When the username was last set. A handle is how other people address
     * this account, so it may only be changed once a month - see
     * common/utils/identity-change.util. Null on an account that never
     * claimed one, which is always free to.
     */
    handleChangedAt: timestamp('handle_changed_at', { withTimezone: true }),
    emailVerified: boolean('email_verified').notNull().default(false),
    // True once the account proves the phone number by OTP
    // (/auth/verify/phone/*). Required, together with `emailVerified`, before
    // the account may create a shop. The SMS gateway is still a stub, so the
    // code is handed back to the caller rather than texted.
    phoneVerified: boolean('phone_verified').notNull().default(false),
    /**
     * ISO timestamps of the recent times this account moved to a different
     * verified number, newest first. Two are allowed per fortnight, so only
     * the entries still inside that window are kept - the rest can never
     * refuse a change again. Null on an account that has never changed one.
     */
    phoneChanges: jsonb('phone_changes').$type<string[]>(),
    // Saved checkout details (autofill the storefront order form). All optional.
    // Phone holds the bare 10 digits after +880 (same format checkout captures).
    addressLine: text('address_line'),
    addressCity: varchar('address_city', { length: 120 }),
    addressPincode: varchar('address_pincode', { length: 24 }),
    geo: jsonb('geo').$type<BuyerGeoValue>(),
    // Payment-method code from the account's most recent order (preselected at checkout).
    lastPayMethod: varchar('last_pay_method', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('users_public_id_unique_idx').on(table.publicId),
    uniqueIndex('users_email_unique_idx').on(table.email),
    uniqueIndex('users_google_id_unique_idx').on(table.googleId),
    index('users_phone_idx').on(table.phone),
    uniqueIndex('users_handle_unique_idx').on(table.handle),
  ],
);

export const usersRelations = relations(users, ({ many }) => ({
  shops: many(shops),
}));

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
