import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * Postgres enum types shared across the schema. Values are kept identical to
 * the design handoff's `models.ts` string unions so the API contract and the
 * database stay in lock-step.
 */

export const authMethodEnum = pgEnum('auth_method', [
  'email',
  'google',
  'phone',
]);

// Console access tiers. Postgres enum values are append-only, so 'editor'
// (reports + full item CRUD — between 'manager' and 'staff') sits last here;
// what each role can do is defined in common/auth/admin-permissions.ts.
export const adminRoleEnum = pgEnum('admin_role', [
  'owner',
  'manager',
  'staff',
  'editor',
]);

// The storefront UI language buyers land on for this shop. Buyers can still
// switch languages themselves — this only sets which one they see first.
export const shopLanguageEnum = pgEnum('shop_language', ['en', 'bn']);

// Broad retail taxonomy so any kind of shop finds a fit, with 'Other' as the
// catch-all. Postgres enum values are append-only: new categories go at the
// end; display ordering is handled by SHOP_CATEGORIES below.
export const shopCategoryEnum = pgEnum('shop_category', [
  'Food & grocery',
  'Fashion',
  'Handmade',
  'Beauty',
  'Home goods',
  'Bakery',
  'Other',
  'Electronics & gadgets',
  'Health & wellness',
  'Jewellery & accessories',
  'Books & stationery',
  'Toys & games',
  'Baby & kids',
  'Sports & outdoors',
  'Pets & supplies',
  'Furniture & decor',
  'Automotive',
  'Art & collectibles',
  'Flowers & gifts',
  'Digital products & services',
]);

/** Display order for pickers — alphabetical with 'Other' last. */
export const SHOP_CATEGORIES: string[] = [
  ...shopCategoryEnum.enumValues.filter((c) => c !== 'Other').sort(),
  'Other',
];

// Seller business verification (trade-license KYC) state. Optional at shop
// creation — a shop starts 'unsubmitted' and can be completed any time from
// the seller console. 'pending' means a document was submitted and is awaiting
// review; an operator can later move it to 'verified' or 'rejected'.
export const kycStatusEnum = pgEnum('kyc_status', [
  'unsubmitted',
  'pending',
  'verified',
  'rejected',
]);

export const brandSwatchEnum = pgEnum('brand_swatch', [
  'amber',
  'blue',
  'green',
  'rose',
  'violet',
  'clay',
]);

// Universal product badges that apply to any catalog — food, fashion,
// electronics, etc. The legacy food-specific values ('In season', 'Snack')
// are kept so existing rows stay valid; new universal tags are appended.
export const productTagEnum = pgEnum('product_tag', [
  'Bestseller',
  'In season',
  'Gift',
  'Snack',
  'New',
  'Sale',
  'Limited',
  'Popular',
  'Trending',
  'Premium',
]);

// How a product can be acquired. 'sale' is the normal online-checkout flow;
// 'showcase' items are advertised only (e.g. flat shares, big-ticket goods
// sold offline) — buyers read about them and contact the seller directly.
export const listingTypeEnum = pgEnum('listing_type', ['sale', 'showcase']);

// Fulfilment pipeline. Buyers land on 'New' (awaiting the seller's confirmation
// call); the seller confirms — 'Confirmed' — before the order is packed and sent
// out. 'Cancelled' is a terminal state for orders the customer never confirmed.
// Enum values are append-only in Postgres, so 'Confirmed'/'Cancelled' sit at the
// end here — the logical order (New → Confirmed → Packed → Shipped → Delivered)
// is enforced by STATUS_FLOW in the orders service and the UI, not by this list.
export const orderStatusEnum = pgEnum('order_status', [
  'New',
  'Packed',
  'Shipped',
  'Delivered',
  'Confirmed',
  'Cancelled',
]);

// 'Paid' = money confirmed received (gateway-verified or seller-confirmed).
// 'Due' = order accepted, money not yet in hand (COD before delivery, or a
// direct wallet transfer the seller hasn't confirmed). 'Pending' = a gateway
// payment is in flight (buyer redirected to bKash but not returned yet) —
// pending orders are hidden from the seller pipeline and auto-expire.
// Enum values are append-only in Postgres, so the new states sit last.
export const paymentStatusEnum = pgEnum('payment_status', [
  'Paid',
  'Refunded',
  'Due',
  'Pending',
]);

// Shop pricing tier. 'free' = no subscription: 1 product, 10 lifetime orders,
// deactivated at the cap until upgraded. 'paid' = the monthly fee.
export const shopPlanEnum = pgEnum('shop_plan', ['free', 'paid']);

// Which payment gateway (if any) collects a checkout method's money. 'none'
// = trust-based (COD, or a direct wallet transfer the platform never holds).
export const paymentGatewayEnum = pgEnum('payment_gateway', ['none', 'bkash']);

export const paymentMethodEnum = pgEnum('payment_method', [
  'mbank',
  'card',
  'cod',
]);

export const mobileBankAppEnum = pgEnum('mobile_bank_app', [
  'bkash',
  'nagad',
  'rocket',
]);

export const salesChannelEnum = pgEnum('sales_channel', [
  'Store',
  'Instagram',
  'WhatsApp',
]);

export const customerSegmentEnum = pgEnum('customer_segment', [
  'VIP',
  'Repeat',
  'New',
]);

// Platform subscription (the monthly per-shop fee sellers pay Hoomri).
export const subscriptionStatusEnum = pgEnum('subscription_status', [
  'active',
  'past_due',
  'cancelled',
]);

// 'upgrade' = the prorated difference charged when a shop moves up a plan
// mid-period. Enum values are append-only in Postgres, so it sits last.
export const platformPaymentTypeEnum = pgEnum('platform_payment_type', [
  'shop_creation',
  'renewal',
  'upgrade',
]);

export const platformPaymentMethodEnum = pgEnum('platform_payment_method', [
  'auto',
  'manual',
]);

// Visual tone of a platform-to-seller notice banner.
export const noticeToneEnum = pgEnum('notice_tone', [
  'info',
  'success',
  'warning',
  'danger',
]);

// ── Convenience union types derived from the pg enums ──────────
export type AuthMethod = (typeof authMethodEnum.enumValues)[number];
export type AdminRole = (typeof adminRoleEnum.enumValues)[number];
export type ShopCategory = (typeof shopCategoryEnum.enumValues)[number];
export type BrandSwatch = (typeof brandSwatchEnum.enumValues)[number];
export type KycStatus = (typeof kycStatusEnum.enumValues)[number];
export type ProductTag = (typeof productTagEnum.enumValues)[number];
export type ListingType = (typeof listingTypeEnum.enumValues)[number];
export type OrderStatus = (typeof orderStatusEnum.enumValues)[number];
export type PaymentStatus = (typeof paymentStatusEnum.enumValues)[number];
export type PaymentMethod = (typeof paymentMethodEnum.enumValues)[number];
export type MobileBankApp = (typeof mobileBankAppEnum.enumValues)[number];
export type SalesChannel = (typeof salesChannelEnum.enumValues)[number];
export type CustomerSegment = (typeof customerSegmentEnum.enumValues)[number];
export type SubscriptionStatus =
  (typeof subscriptionStatusEnum.enumValues)[number];
export type PlatformPaymentType =
  (typeof platformPaymentTypeEnum.enumValues)[number];
export type PlatformPaymentMethod =
  (typeof platformPaymentMethodEnum.enumValues)[number];
export type NoticeTone = (typeof noticeToneEnum.enumValues)[number];
export type ShopPlan = (typeof shopPlanEnum.enumValues)[number];
export type PaymentGateway = (typeof paymentGatewayEnum.enumValues)[number];
