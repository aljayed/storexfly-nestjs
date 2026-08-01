/**
 * Platform billing constants, shared by the subscriptions and coupons
 * modules (kept out of the services to avoid an import cycle between them).
 */

/**
 * Fallback monthly platform fee per shop, ৳599.00 in integer paisa — the
 * entry (Starter) plan's price. The live catalog is operator-editable and
 * lives in `subscription_plans`; read it through the plan helpers on
 * `BillingSettingsService`. This constant only backs a catalog read that
 * fails and seeds a fresh database.
 */
export const DEFAULT_MONTHLY_FEE_CENTS = 59900;
export const PLATFORM_CURRENCY = 'BDT';

// ── Plan ladder ───────────────────────────────────────────────────
// Five tiers priced by how much a shop sells in a billing period. Each tier
// carries a monthly sales cap; the top tier is uncapped ("sell as much as you
// like"). Sales are measured as the value of every non-cancelled order placed
// inside the current billing period, so the meter and the invoice cover the
// same days.
//
// This array is the seed *and* the fallback: the live prices and caps are the
// `subscription_plans` rows, which an operator can re-price from the console.
// The order here is the ladder order — auto-scale walks it upwards.
export interface PlanTierSeed {
  code: string;
  name: string;
  /** Monthly sales ceiling in paisa; `null` = uncapped (top tier). */
  salesCapCents: number | null;
  priceCents: number;
}

export const PLAN_TIERS: readonly PlanTierSeed[] = [
  { code: 'starter', name: 'Starter', salesCapCents: 10_000_000, priceCents: 59_900 },
  { code: 'growth', name: 'Growth', salesCapCents: 25_000_000, priceCents: 119_900 },
  { code: 'business', name: 'Business', salesCapCents: 50_000_000, priceCents: 249_900 },
  { code: 'scale', name: 'Scale', salesCapCents: 100_000_000, priceCents: 459_900 },
  { code: 'unlimited', name: 'Unlimited', salesCapCents: null, priceCents: 1_199_000 },
];

/** The plan a shop lands on when it first subscribes. */
export const ENTRY_PLAN_CODE = PLAN_TIERS[0].code;

/**
 * How long a shop keeps selling after its sales pass the plan cap while
 * auto-scale is off. When the grace runs out the storefront is paused until
 * the seller upgrades (or the period rolls over and the meter resets).
 */
export const CAP_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

// ── Free tier ─────────────────────────────────────────────────────
// A shop on the free plan carries hard limits: one product in the catalog
// and 10 lifetime (non-cancelled) orders. The order that fills the last slot
// still completes; the shop is then deactivated until it subscribes.
export const FREE_MAX_PRODUCTS = 1;
export const FREE_ORDER_CAP = 10;
export const FREE_TIER_LIMIT_MESSAGE =
  'This shop used up the free plan’s 10 free orders and is paused. Subscribe to keep selling.';
