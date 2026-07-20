import {
  boolean,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

/**
 * A pinned map location the buyer saved at checkout. `line`/`area`/`pin` are the
 * human-readable address for the drop. `lat`/`lng` are the exact geographic
 * coordinates from the interactive delivery map. `x`/`y` are the legacy canvas
 * pin position (percent) kept for pins saved before the real map — all four are
 * optional so either representation validates.
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
 * A buyer account — a shopper who signs in to leave reviews on products they
 * bought. Distinct from `customers` (per-shop order aggregates with no login)
 * and from seller `users`. Purchase is verified by matching this email against
 * the email captured on their orders at checkout.
 */
export const buyers = pgTable(
  'buyers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 160 }).notNull(),
    email: varchar('email', { length: 320 }).notNull(),
    passwordHash: varchar('password_hash', { length: 255 }).notNull(),
    // Saved checkout details, used to autofill the order form. All optional —
    // a buyer can sign in without ever filling these in. Phone holds the 10
    // digits after +880 (same format the checkout form captures).
    phone: varchar('phone', { length: 24 }),
    addressLine: text('address_line'),
    addressCity: varchar('address_city', { length: 120 }),
    addressPincode: varchar('address_pincode', { length: 24 }),
    // Saved map-pin location (see BuyerGeoValue). Null until they pin one.
    geo: jsonb('geo').$type<BuyerGeoValue>(),
    // True only for accounts created via the OTP-verified signup modal; the
    // instant account created inline at checkout is never verified this way.
    emailVerified: boolean('email_verified').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex('buyers_email_unique_idx').on(table.email)],
);

export type BuyerRow = typeof buyers.$inferSelect;
export type NewBuyerRow = typeof buyers.$inferInsert;
