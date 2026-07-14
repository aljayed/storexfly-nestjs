import {
  boolean,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { paymentMethodEnum } from './enums';

/**
 * A checkout payment method (e.g. "bKash", "Card — SSLCommerz", "Cash on
 * Delivery"), managed from the platform-admin console. `code` is the stable
 * slug orders reference; `kind` groups methods by behaviour — 'mbank' methods
 * run the wallet checkout flow, 'card' the card form, 'cod' skips payment —
 * and is what per-product payment toggles are matched against.
 *
 * Deleting a method that historical orders reference only disables it
 * (`enabled = false`) so settlement math keeps its fee rate and title; a
 * never-used method is removed outright. The COD row is `locked`: always
 * present, always enabled, always fee-free.
 */
export const paymentMethods = pgTable(
  'payment_methods',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: varchar('code', { length: 40 }).notNull(),
    kind: paymentMethodEnum('kind').notNull(),
    title: varchar('title', { length: 80 }).notNull(),
    subtitle: varchar('subtitle', { length: 140 }),
    // Processing fee in basis points (300 = 3%), deducted from each payment
    // before it is settled to the seller. Always 0 for COD.
    feeBp: integer('fee_bp').notNull().default(0),
    enabled: boolean('enabled').notNull().default(true),
    locked: boolean('locked').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [uniqueIndex('payment_methods_code_unique_idx').on(table.code)],
);

export type PaymentMethodRow = typeof paymentMethods.$inferSelect;
export type NewPaymentMethodRow = typeof paymentMethods.$inferInsert;
