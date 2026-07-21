import { relations } from 'drizzle-orm';
import {
  boolean,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { coupons } from './coupons.schema';

/**
 * Referral links, managed from the platform admin console. Each link is a
 * shareable URL (hoomri.com/r/<slug>) tied to one coupon: opening it shows
 * the seller a discounted first month and auto-applies the coupon to the
 * shop-creation payment. Renewals always charge full price — later coupons
 * are applied manually from the seller console. Slugs are stored lowercase
 * and matched case-insensitively.
 */
export const referralLinks = pgTable(
  'referral_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: varchar('slug', { length: 60 }).notNull(),
    // Operator label ("Facebook ads July", a referrer's name…).
    name: varchar('name', { length: 120 }),
    couponId: uuid('coupon_id')
      .notNull()
      .references(() => coupons.id, { onDelete: 'cascade' }),
    active: boolean('active').notNull().default(true),
    // How many times the link was opened (public resolves).
    clicks: integer('clicks').notNull().default(0),
    // First payments where this link's coupon was auto-applied.
    signups: integer('signups').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [uniqueIndex('referral_links_slug_unique_idx').on(table.slug)],
);

export const referralLinksRelations = relations(referralLinks, ({ one }) => ({
  coupon: one(coupons, {
    fields: [referralLinks.couponId],
    references: [coupons.id],
  }),
}));

export type ReferralLinkRow = typeof referralLinks.$inferSelect;
export type NewReferralLinkRow = typeof referralLinks.$inferInsert;
