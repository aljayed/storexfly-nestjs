import { relations } from 'drizzle-orm';
import {
  doublePrecision,
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
import { listingTypeEnum, paymentMethodEnum, productTagEnum } from './enums';
import { shops } from './shops.schema';
import { reviews } from './reviews.schema';

/**
 * One choice inside a variant group (e.g. "Large"). `priceDeltaCents` adjusts
 * the base unit price when this option is picked (can be negative). Ids are
 * short random slugs assigned by the API on save, so a buyer's selection stays
 * valid even if the seller re-labels an option.
 */
export interface ProductVariantOption {
  id: string;
  label: string;
  priceDeltaCents: number;
  /**
   * Photo shown in the gallery while this option is selected (a `/api/media`
   * URL — the same absorbed-storage path product photos take). Absent = the
   * option has no picture of its own and the gallery stays put.
   */
  image?: string | null;
  /**
   * Units left of this specific choice. `null`/absent = untracked, in which
   * case only the product-level `stock` limits it. When several groups track
   * stock the smallest tracked number wins — see `variantStockFor` in the
   * orders service.
   */
  stock?: number | null;
}

/**
 * A buyer-facing option group (e.g. "Size" or "Color"). A product carries at
 * most 2 groups; the buyer picks exactly one option per group and the deltas
 * add onto the base unit price. Product-level `stock` is always the ceiling;
 * an option may additionally track its own count (see `stock` above).
 */
export interface ProductVariantGroup {
  id: string;
  name: string;
  options: ProductVariantOption[];
}

/**
 * A multi-buy bundle: `units` units sold together for `priceCents` total
 * (usually below units × base price — the storefront shows the savings).
 * The single unit at base price is always offered alongside the packs.
 */
export interface ProductPack {
  id: string;
  label: string;
  units: number;
  priceCents: number;
}

/**
 * A catalog item within a shop. Maps to `Product` in the design handoff.
 * Money is stored as integer cents (`priceCents`) to avoid floating-point
 * drift; the API layer exposes it as a decimal `price`.
 */
export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 200 }).notNull(),
    slug: varchar('slug', { length: 220 }).notNull(),
    cat: varchar('cat', { length: 80 }).notNull(),
    // 'sale' = normal online checkout; 'showcase' = advertise-only, buyers
    // contact the seller to purchase offline. Showcase items can't be ordered.
    listingType: listingTypeEnum('listing_type').notNull().default('sale'),
    priceCents: integer('price_cents').notNull(),
    // Seller-entered "compare at" (regular) price, struck through next to the
    // real price. Null = no discount display; the storefront also hides it
    // unless it's genuinely above the selling price — never fabricated.
    comparePriceCents: integer('compare_price_cents'),
    unit: varchar('unit', { length: 60 }).notNull(),
    stock: integer('stock').notNull().default(0),
    // Per-product delivery charge in integer cents, split by zone. 0 = free
    // (no charge is shown to buyers). Defaults: Dhaka ৳70, elsewhere ৳120.
    deliveryDhakaCents: integer('delivery_dhaka_cents').notNull().default(7000),
    deliveryOutsideCents: integer('delivery_outside_cents')
      .notNull()
      .default(12000),
    emoji: varchar('emoji', { length: 16 }).notNull().default('📦'),
    tone: varchar('tone', { length: 9 }).notNull().default('#f3f1ec'),
    tag: productTagEnum('tag'),
    // Payment methods a buyer may use for this item. Defaults to all three;
    // a seller can disable some, but at least one must stay enabled.
    paymentMethods: paymentMethodEnum('payment_methods')
      .array()
      .notNull()
      .default(['mbank', 'card', 'cod']),
    rating: doublePrecision('rating').notNull().default(0),
    reviewsCount: integer('reviews_count').notNull().default(0),
    blurb: text('blurb').notNull().default(''),
    images: text('images').array(),
    // Optional product video — a YouTube watch/share/embed URL. Rendered as an
    // embedded player on the storefront product page.
    videoUrl: text('video_url'),
    // Buyer-facing option groups (Size, Color, …) — at most 2, deltas on the
    // base price. Empty = the product has no variants.
    variantGroups: jsonb('variant_groups')
      .$type<ProductVariantGroup[]>()
      .notNull()
      .default([]),
    // Multi-buy bundles ("Pack of 3 — ৳270"). Empty = only singles are sold.
    packs: jsonb('packs').$type<ProductPack[]>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('products_shop_slug_unique_idx').on(table.shopId, table.slug),
    index('products_shop_cat_idx').on(table.shopId, table.cat),
  ],
);

export const productsRelations = relations(products, ({ one, many }) => ({
  shop: one(shops, {
    fields: [products.shopId],
    references: [shops.id],
  }),
  reviews: many(reviews),
}));

export type ProductRow = typeof products.$inferSelect;
export type NewProductRow = typeof products.$inferInsert;
