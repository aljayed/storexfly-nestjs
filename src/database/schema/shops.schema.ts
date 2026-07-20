import { relations } from 'drizzle-orm';
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
import type { TrustBadge } from '../../common/constants/trust-badges';
import {
  brandSwatchEnum,
  kycStatusEnum,
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
    // Storefront hero banner images, stored inline as data URLs (same approach
    // as product images). Ordered; the storefront rotates through them.
    bannerImages: text('banner_images').array(),
    // Decorative images that float over the hero banner (replace the default
    // product-emoji bubbles). Also inline data URLs, in display order.
    floatingImages: text('floating_images').array(),
    // Seller-managed "why buy" strip on the product page (packed fresh, fast
    // delivery, …). Null means the seller never touched it — the storefront
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
    // Pricing tier. Free shops carry hard limits (1 product, ৳5,000 lifetime
    // sales) and are deactivated at the sales cap until they subscribe.
    // Existing shops predate the free tier and stay 'paid'.
    plan: shopPlanEnum('plan').notNull().default('paid'),
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
  (table) => [uniqueIndex('shops_handle_unique_idx').on(table.handle)],
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
