import {
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

/**
 * Platform-wide settings - a single global row managed from the platform-admin
 * console. Holds the brand: either the text wordmark (the rounded "happy" font
 * logotype) or, when set, an uploaded image logo that takes precedence. Every
 * surface - the public storefront included - reads it, so an operator can
 * rebrand without a code change.
 *
 * Singleton: the app seeds one row at boot and always reads/updates the first.
 */
export const platformSettings = pgTable('platform_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  // The logotype text, e.g. "hoomri". Rendered in the rounded "happy" font.
  brandWordmark: varchar('brand_wordmark', { length: 40 })
    .notNull()
    .default('hoomri'),
  // Substring of the wordmark tinted in the brand accent colour (e.g. "oo").
  // null/empty = no tinted segment.
  brandAccent: varchar('brand_accent', { length: 40 }).default('oo'),
  // Active image logos, stored inline as data URLs (same approach as product
  // photos - no upload server needed). A surface picks the one matching its
  // background; null = fall back to the text wordmark for that theme.
  logoLight: text('logo_light'),
  logoDark: text('logo_dark'),
  // Browser-tab icon, stored inline as a data URL. null = the app's default.
  favicon: text('favicon'),
  // What a verified merchant pays on the post-paid track, in basis points
  // (150 = 1.5%). Operator-editable from the console; every quote and every
  // monthly bill reads it, so exactly one rate is live at a time.
  commissionBps: integer('commission_bps').notNull().default(150),
  // Legacy gateway fee rates in basis points. Live rates now live per-method
  // on `payment_methods`; these only seed that table's first migration and
  // back old paid-settlement snapshots.
  mbankFeeBp: integer('mbank_fee_bp').notNull().default(300),
  cardFeeBp: integer('card_fee_bp').notNull().default(350),
  // Operator-editable copy of the info banner on the seller settlements page.
  // null/empty = the app renders its built-in default explanation.
  settlementBanner: text('settlement_banner'),
  // ── bKash merchant credentials (Tokenized Checkout) ─────────────
  // Set from the platform-admin console; secrets never leave the API in
  // readable form. Sandbox mode targets bKash's test environment.
  bkashEnabled: boolean('bkash_enabled').notNull().default(false),
  bkashSandbox: boolean('bkash_sandbox').notNull().default(true),
  bkashAppKey: text('bkash_app_key'),
  bkashAppSecret: text('bkash_app_secret'),
  bkashUsername: text('bkash_username'),
  bkashPassword: text('bkash_password'),
  // ── Steadfast courier credentials (LEGACY, no longer read) ──────
  // Couriers moved to per-shop credentials in `shop_couriers`; these
  // columns only preserve what the operator had entered before that.
  steadfastEnabled: boolean('steadfast_enabled').notNull().default(false),
  steadfastApiKey: text('steadfast_api_key'),
  steadfastSecretKey: text('steadfast_secret_key'),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/**
 * Gallery of uploaded brand logos - the "recent images" an operator can pick
 * from on the branding screen. Each image is a resized data URL.
 */
export const brandLogos = pgTable('brand_logos', {
  id: uuid('id').primaryKey().defaultRandom(),
  dataUrl: text('data_url').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type PlatformSettingsRow = typeof platformSettings.$inferSelect;
export type NewPlatformSettingsRow = typeof platformSettings.$inferInsert;
export type BrandLogoRow = typeof brandLogos.$inferSelect;
