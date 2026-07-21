/**
 * Platform billing constants, shared by the subscriptions and coupons
 * modules (kept out of the services to avoid an import cycle between them).
 */

/**
 * Fallback monthly platform fee per shop, ৳599.00 in integer paisa. The live
 * price is operator-editable and lives on the platform-settings singleton —
 * read it through `BillingSettingsService.monthlyFeeCents()`. This constant
 * only seeds a fresh database and backs a settings read that fails.
 */
export const DEFAULT_MONTHLY_FEE_CENTS = 59900;
export const PLATFORM_CURRENCY = 'BDT';

// ── Free tier ─────────────────────────────────────────────────────
// A shop on the free plan carries hard limits: one product in the catalog
// and ৳5,000 of lifetime (non-cancelled) order value. The order that crosses
// the cap still completes; the shop is then deactivated until it subscribes.
export const FREE_MAX_PRODUCTS = 1;
export const FREE_SALES_CAP_CENTS = 500_000;
export const FREE_TIER_LIMIT_MESSAGE =
  'This shop reached the free plan’s ৳5,000 sales limit and is paused. Subscribe to keep selling.';
