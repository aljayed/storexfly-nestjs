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
 * Couriers the platform can book parcels with. Stored on orders as
 * `courier_provider`, so the strings are part of the data - append, don't
 * rename.
 */
export const COURIER_PROVIDERS = ['carrybee', 'steadfast', 'pathao'] as const;
export type CourierProvider = (typeof COURIER_PROVIDERS)[number];

/**
 * Platform-wide settings - a single global row managed from the platform-admin
 * console. Holds the brand: either the text wordmark (the rounded "happy" font
 * logotype) or, when set, an uploaded image logo that takes precedence. Every
 * surface - the public storefront included - reads it, so an operator can
 * rebrand without a code change.
 *
 * Also holds the platform's own gateway and courier merchant credentials: one
 * bKash account and one courier account serve every shop, which is what keeps
 * the money and the parcel trail inside the platform.
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
  // ── Couriers (platform-held merchant accounts) ──────────────────
  // Every parcel on the platform is booked on the operator's own courier
  // account, never a seller's: the courier is the one party in the flow a
  // shop cannot edit, so its consignment - not the seller's word - is what
  // moves an order to Shipped/Delivered and what the sales meter trusts.
  //
  // At most one provider is `enabled` at a time (enabling one clears the
  // others); `courierRequired` then decides whether a shop may still ship a
  // parcel outside it. Secrets never leave the API in readable form.
  //
  // CarryBee (developers.carrybee.com) - the primary integration.
  //
  // CarryBee issues two independent credential triples, one per environment,
  // and both stay valid forever - so both are stored rather than one set that
  // an environment switch invalidates. `carrybeeSandbox` only chooses which
  // pair is live; flipping it never silently points sandbox credentials at
  // the production host, which would fail auth for every shop at once.
  carrybeeEnabled: boolean('carrybee_enabled').notNull().default(false),
  // true = the sandbox credentials and sandbox.carrybee.com are in use.
  carrybeeSandbox: boolean('carrybee_sandbox').notNull().default(true),
  // Production triple.
  carrybeeClientId: text('carrybee_client_id'),
  carrybeeClientSecret: text('carrybee_client_secret'),
  carrybeeClientContext: text('carrybee_client_context'),
  // The pickup store parcels are collected from, chosen from the account's
  // store list. Required before a booking can go out. Stores are registered
  // per environment, so this is per environment too.
  carrybeeStoreId: varchar('carrybee_store_id', { length: 64 }),
  // Sandbox triple, same shape.
  carrybeeSandboxClientId: text('carrybee_sandbox_client_id'),
  carrybeeSandboxClientSecret: text('carrybee_sandbox_client_secret'),
  carrybeeSandboxClientContext: text('carrybee_sandbox_client_context'),
  carrybeeSandboxStoreId: varchar('carrybee_sandbox_store_id', { length: 64 }),
  // Secret CarryBee sends in X-CB-Webhook-Integration-Header and expects
  // echoed back. Its Webhook Integration screen registers a URL per
  // environment ("Try Sandbox"), each with its own secret, so both are held.
  // A callback carries no environment marker, so the route accepts either -
  // it cannot tell them apart, and a consignment id only exists in one.
  carrybeeWebhookSecret: text('carrybee_webhook_secret'),
  carrybeeSandboxWebhookSecret: text('carrybee_sandbox_webhook_secret'),
  // Steadfast (portal.packzy.com), kept as a fallback carrier.
  steadfastEnabled: boolean('steadfast_enabled').notNull().default(false),
  steadfastApiKey: text('steadfast_api_key'),
  steadfastSecretKey: text('steadfast_secret_key'),
  // Pathao (api-hermes.pathao.com), kept as a fallback carrier.
  pathaoEnabled: boolean('pathao_enabled').notNull().default(false),
  pathaoSandbox: boolean('pathao_sandbox').notNull().default(false),
  pathaoClientId: text('pathao_client_id'),
  pathaoClientSecret: text('pathao_client_secret'),
  pathaoUsername: text('pathao_username'),
  pathaoPassword: text('pathao_password'),
  pathaoStoreId: varchar('pathao_store_id', { length: 40 }),
  // When on, a shop may only ship through the platform courier: the manual
  // Shipped/Delivered steps disappear and an order can't leave 'HandedOver'
  // without a consignment behind it. Off by default so enabling the feature
  // never strands shops that are mid-fulfilment.
  courierRequired: boolean('courier_required').notNull().default(false),
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
