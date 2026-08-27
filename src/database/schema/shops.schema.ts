import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import type { TrustBadge } from '../../common/constants/trust-badges';
import {
  brandSwatchEnum,
  kycStatusEnum,
  paymentMethodEnum,
  shopCategoryEnum,
  shopLanguageEnum,
  shopPlanEnum,
} from './enums';
import { users } from './users.schema';
import { products } from './products.schema';
import { orders } from './orders.schema';
import { customers } from './customers.schema';
import { adminUsers } from './admin-users.schema';

/**
 * Where monthly settlement payouts are transferred: a bank account or a
 * mobile-wallet number. Optional until the shop has online revenue to
 * receive; snapshotted into `deleted_shop_settlements` when a shop with
 * money still owed is deleted.
 */
export interface PayoutBank {
  bankName: string;
  accountName: string;
  accountNumber: string;
  branch?: string;
}

/**
 * A seller's branded storefront, reachable at hoomri.com/shops/<handle>.
 * Maps to `Shop` in the design handoff. `brand`/`brandSoft` are the resolved
 * hex values for the chosen swatch and drive the per-shop CSS custom props.
 */
export const shops = pgTable(
  'shops',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 160 }).notNull(),
    handle: varchar('handle', { length: 80 }).notNull(),
    tagline: varchar('tagline', { length: 240 }),
    // Buyer-facing support contacts shown on the storefront. Optional.
    supportEmail: varchar('support_email', { length: 320 }),
    supportPhone: varchar('support_phone', { length: 24 }),
    // ── Where the courier collects this shop's parcels ─────────────
    // This is a marketplace: every shop ships from its own address, so the
    // pickup point belongs to the shop and never to the platform. It is what
    // the courier's per-shop pickup store is registered from (see
    // `shop_courier_stores`), which is why the city/zone/area are the
    // courier's own numeric ids and not free text.
    //
    // Never shown to buyers - it is a warehouse door, not a shopfront.
    pickupContactName: varchar('pickup_contact_name', { length: 60 }),
    pickupPhone: varchar('pickup_phone', { length: 24 }),
    pickupAddress: varchar('pickup_address', { length: 200 }),
    pickupCityId: integer('pickup_city_id'),
    pickupZoneId: integer('pickup_zone_id'),
    pickupAreaId: integer('pickup_area_id'),
    // Storefront hero banner images, stored inline as data URLs (same approach
    // as product images). Ordered; the storefront rotates through them.
    bannerImages: text('banner_images').array(),
    // Decorative images that float over the hero banner (replace the default
    // product-emoji bubbles). Also inline data URLs, in display order.
    floatingImages: text('floating_images').array(),
    // Seller-managed "why buy" strip on the product page (packed fresh, fast
    // delivery, …). Null means the seller never touched it - the storefront
    // then shows its translated defaults. See constants/trust-badges.ts.
    trustBadges: jsonb('trust_badges').$type<TrustBadge[]>(),
    cat: shopCategoryEnum('cat').notNull().default('Other'),
    // ISO 4217 currency code the shop prices in (see SUPPORTED_CURRENCIES).
    currency: varchar('currency', { length: 3 }).notNull().default('BDT'),
    // Default storefront UI language for buyers landing on this shop. Buyers
    // can still switch via the storefront's language toggle.
    language: shopLanguageEnum('language').notNull().default('en'),
    brandId: brandSwatchEnum('brand_id').notNull().default('amber'),
    brand: varchar('brand', { length: 9 }).notNull(),
    brandSoft: varchar('brand_soft', { length: 9 }).notNull(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Buyer-facing on/off switch. When false the public storefront, catalog
    // and checkout endpoints all refuse to serve the shop. Forced off when
    // the platform subscription is cancelled.
    live: boolean('live').notNull().default(true),
    // ── Platform suspension ────────────────────────────────────────
    // The operator's lock, and deliberately a separate column from `live`:
    // `live` is the seller's own switch (and the one billing pauses), so a
    // suspension written into it would be undone the moment the seller
    // re-opens the shop or the next payment lifts the billing pause.
    // While this is set the shop is off and stays off - only the platform
    // console can clear it. Suspending also forces `live` false, so every
    // buyer-facing check that already reads `live` keeps working unchanged.
    suspendedAt: timestamp('suspended_at', { withTimezone: true }),
    // Shown to the seller so a suspension is never silent.
    suspendedReason: varchar('suspended_reason', { length: 300 }),
    // Pricing tier. Free shops list as much as they like but are capped at 10
    // lifetime orders, and are deactivated at that cap until they buy credit
    // or verify. Existing shops predate the free tier and stay 'paid'.
    plan: shopPlanEnum('plan').notNull().default('paid'),
    // AI auto-reply in the seller inbox. When on, an incoming customer message
    // gets an answer from the shop's own catalog while the seller is away; the
    // agent hands the thread back to the human when it escalates.
    // Off by default - the agent writes as the shop's staff, so opting an
    // existing seller in without asking would put words in their mouth.
    botChatEnabled: boolean('bot_chat_enabled').notNull().default(false),
    // Checkout methods apply to the whole shop. Keeping this beside the other
    // storefront settings makes a seller's choice consistent across products,
    // carts, combos and chat offers.
    paymentMethods: paymentMethodEnum('payment_methods')
      .array()
      .notNull()
      .default(['mbank', 'card', 'cod']),
    // Require an online 15% advance whenever a buyer chooses the COD track.
    // The balance is still collected at the door; this merely verifies intent
    // before stock is reserved and a parcel is dispatched.
    codAdvanceEnabled: boolean('cod_advance_enabled').notNull().default(false),
    // Take orders from signed-in customers only. Off by default, because it
    // costs a shop every buyer who will not make an account - it is the
    // seller's own trade to make, not one the platform makes for them.
    // A signed-in buyer is an account that can be looked at, warned and
    // blocked, and one whose proved phone number carries between orders, so a
    // shop drowning in fake Cash-on-Delivery orders can shut the door on
    // throwaway ones.
    requireBuyerLogin: boolean('require_buyer_login').notNull().default(false),
    // Bank/wallet account monthly settlements are transferred to.
    payoutBank: jsonb('payout_bank').$type<PayoutBank>(),
    // ── Business verification (trade-license KYC) ──────────────────
    // All optional: a shop can be created and go live without any of this,
    // and the seller can complete or update it later from the console.
    // `kycDocument` holds the uploaded trade licence inline as a data URL
    // (same approach as product images); it is never sent to public routes.
    kycStatus: kycStatusEnum('kyc_status').notNull().default('unsubmitted'),
    kycLegalName: varchar('kyc_legal_name', { length: 200 }),
    kycLicenseNo: varchar('kyc_license_no', { length: 120 }),
    kycDocument: text('kyc_document'),
    kycSubmittedAt: timestamp('kyc_submitted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('shops_handle_unique_idx').on(table.handle),
    /**
     * One trade licence, one shop.
     *
     * A licence is the document that says a real business stands behind a
     * storefront, and it is what unlocks a seller's later shops. Letting the
     * same number sit on two shops at once would let one licence vouch for a
     * catalogue its holder never agreed to, so the database refuses it rather
     * than trusting every write path to remember.
     *
     * Matched on the number with its whitespace stripped and upper-cased:
     * "trad/dncc/004912/2026" and "TRAD / DNCC / 004912 / 2026" are one
     * licence, and a seller retyping their own number should not be able to
     * duplicate it by shifting a space.
     *
     * Partial, so the shops that have submitted nothing (the column is
     * nullable and most rows are null) do not collide with each other.
     * Deleting a shop hands the number straight back - the row goes with it.
     */
    uniqueIndex('shops_kyc_license_unique_idx')
      .on(sql`upper(regexp_replace(${table.kycLicenseNo}, '\s', '', 'g'))`)
      .where(sql`${table.kycLicenseNo} is not null`),
  ],
);

export const shopsRelations = relations(shops, ({ one, many }) => ({
  owner: one(users, {
    fields: [shops.ownerId],
    references: [users.id],
  }),
  products: many(products),
  orders: many(orders),
  customers: many(customers),
  admins: many(adminUsers),
}));

export type ShopRow = typeof shops.$inferSelect;
export type NewShopRow = typeof shops.$inferInsert;
