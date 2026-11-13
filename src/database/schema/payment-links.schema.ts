import { relations, sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { shops } from './shops.schema';

/** Where a link stands. 'expired' is derived from `expiresAt`, never stored. */
export type PaymentLinkStatus = 'active' | 'paid' | 'cancelled' | 'refunded';
export const PAYMENT_LINK_CURRENCIES = ['BDT', 'USD', 'INR'] as const;
export type PaymentLinkCurrency = (typeof PAYMENT_LINK_CURRENCIES)[number];

/**
 * A request for money a shop sends to one buyer as a URL: an amount, what it
 * is for, and nothing else. No cart, no order, no delivery - it exists for
 * the sale that was agreed somewhere this platform cannot see (a phone call,
 * a counter, a custom job) and still needs paying for by card or wallet.
 *
 * One link collects once. The first payment that lands flips it to 'paid' and
 * the page stops offering to pay; what the buyer typed on the way in (their
 * name, number and optional note) is copied here from the checkout session
 * that actually paid, so an abandoned attempt by someone else never overwrites
 * who the money really came from.
 *
 * `token` is the public handle in the URL. It is the only thing a buyer
 * needs and the only thing they are given - never the row id - and it is
 * random enough that links cannot be walked.
 *
 * A seller can send a paid link's money back, which makes it 'refunded':
 * out of the payout, out of the sales credit it used, and never payable again.
 *
 * A paid link is platform-held money like any gateway-collected order, so it
 * joins the shop's payout cycle by `paidAt` under the fee of `paymentMethod`
 * (see SettlementsService).
 */
export const paymentLinks = pgTable(
  'payment_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    token: varchar('token', { length: 24 }).notNull(),
    /** What the money is for, in the seller's words - shown to the buyer. */
    title: varchar('title', { length: 120 }).notNull(),
    description: varchar('description', { length: 500 }),
    amountCents: integer('amount_cents').notNull(),
    currency: varchar('currency', { length: 3 })
      .$type<PaymentLinkCurrency>()
      .notNull()
      .default('BDT'),
    /** Gross BDT collected by SSLCommerz, used for payouts and sales credit. */
    settledAmountCents: integer('settled_amount_cents'),
    status: varchar('status', { length: 16 })
      .$type<PaymentLinkStatus>()
      .notNull()
      .default('active'),
    /** Optional last moment the link may be paid. Null = no deadline. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    /** Hidden unpaid link; retained for callbacks from existing checkouts. */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),

    // ── Filled in when the money lands ─────────────────────────────
    paidAt: timestamp('paid_at', { withTimezone: true }),
    /** Gateway transaction id of the payment that settled the link. */
    trxId: varchar('trx_id', { length: 80 }),
    /** Catalogue code of the method that collected it - sets the payout fee. */
    paymentMethod: varchar('payment_method', { length: 40 }),
    /** What it was paid with, as the gateway named it ('VISA-…', 'BKASH-…'). */
    instrument: varchar('instrument', { length: 60 }),
    payerName: varchar('payer_name', { length: 100 }),
    payerPhone: varchar('payer_phone', { length: 24 }),
    payerEmail: varchar('payer_email', { length: 320 }),
    /** The buyer's own note or reference, typed before paying. */
    payerNote: varchar('payer_note', { length: 300 }),
    /** When the seller sent the money back. Set only on 'refunded'. */
    refundedAt: timestamp('refunded_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    check(
      'payment_links_currency_check',
      sql`${table.currency} in ('BDT', 'USD', 'INR')`,
    ),
    uniqueIndex('payment_links_token_unique_idx').on(table.token),
    index('payment_links_shop_idx').on(table.shopId, table.createdAt),
    // What the payout math reads: one shop's paid links by when they landed.
    index('payment_links_paid_idx').on(table.shopId, table.paidAt),
  ],
);

export const paymentLinksRelations = relations(paymentLinks, ({ one }) => ({
  shop: one(shops, {
    fields: [paymentLinks.shopId],
    references: [shops.id],
  }),
}));

export type PaymentLinkRow = typeof paymentLinks.$inferSelect;
export type NewPaymentLinkRow = typeof paymentLinks.$inferInsert;
