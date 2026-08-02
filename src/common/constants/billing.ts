/**
 * Platform billing constants, shared by the subscriptions and coupons
 * modules (kept out of the services to avoid an import cycle between them).
 */

export const PLATFORM_CURRENCY = 'BDT';

// ── The two billing tracks ────────────────────────────────────────
//
// A shop pays for the sales it makes in exactly one of two ways. There is no
// monthly subscription in either.
//
//   credits     Open to every seller. The shop buys sales credit up front and
//               every taka it sells draws that credit down. Nothing is billed
//               at the end of the month because it has already been paid.
//
//   commission  Only for shops whose trade licence is verified
//               (`shops.kyc_status = 'verified'`). Nothing is paid up front;
//               at the end of each billing month the shop is billed a flat
//               percentage of what it sold in that month.
//
// A shop starts on `credits` and may move to `commission` once it verifies.
// Credit it already bought is never lost in the move: sales draw the balance
// down first, and commission only starts being charged once it runs out.

/** The verified track's rate, in basis points — 150 bps = 1.5%. */
export const COMMISSION_BPS = 150;

/**
 * The most sales credit a shop may hold at once, in paisa (৳10,00,000).
 *
 * This is a ceiling on the *balance*, not a lifetime limit: as a shop sells
 * its credit down, room to buy more opens up again. Sell ৳1,00,000 and you
 * can buy ৳1,00,000 more.
 */
export const CREDIT_BALANCE_CAP_CENTS = 100_000_000;

/**
 * How long a verified shop keeps selling after a monthly commission bill goes
 * unpaid. The seller can settle it by hand from the console at any point
 * inside the window; when it runs out the storefront is paused until they do.
 */
export const COMMISSION_DUE_GRACE_MS = 25 * 24 * 60 * 60 * 1000;

// ── Credit packs ──────────────────────────────────────────────────
//
// What a seller on the credits track buys. `salesCreditCents` is how much
// *selling* the pack pays for; `priceCents` is what the pack costs. Bigger
// packs carry a better rate, which is the whole reason to buy one.
//
// This array is the seed *and* the fallback: the live catalogue is the
// `credit_packs` rows, which an operator re-prices from the platform console.
export interface CreditPackSeed {
  code: string;
  name: string;
  /** Sales this pack pays for, in paisa. */
  salesCreditCents: number;
  /** What the pack costs, in paisa. */
  priceCents: number;
  /** Optional shelf label ('Most popular'), shown on the pack card. */
  badge?: string;
}

export const CREDIT_PACKS: readonly CreditPackSeed[] = [
  {
    code: 'credit-100k',
    name: '৳1,00,000 in sales',
    salesCreditCents: 10_000_000,
    priceCents: 189_900,
  },
  {
    code: 'credit-200k',
    name: '৳2,00,000 in sales',
    salesCreditCents: 20_000_000,
    priceCents: 349_900,
    badge: 'Most popular',
  },
  {
    code: 'credit-500k',
    name: '৳5,00,000 in sales',
    salesCreditCents: 50_000_000,
    priceCents: 829_900,
    badge: 'Best value',
  },
];

/** The pack quoted as "from ৳X" before a seller has picked one. */
export const ENTRY_PACK_CODE = CREDIT_PACKS[0].code;

// ── Free tier ─────────────────────────────────────────────────────
// Creating a shop costs nothing, so every new shop starts here: one product
// in the catalog and 10 lifetime (non-cancelled) orders, enough to try the
// platform with real buyers. The order that fills the last slot still
// completes; the shop is then paused until it buys credit or gets verified.
export const FREE_MAX_PRODUCTS = 1;
export const FREE_ORDER_CAP = 10;
export const FREE_TIER_LIMIT_MESSAGE =
  'This shop used up the free plan’s 10 free orders and is paused. Buy sales credit to keep selling.';

/** Shown when a credits shop has sold through its balance. */
export const CREDIT_EXHAUSTED_MESSAGE =
  'This shop has used up its sales credit and is paused. Top up to keep selling.';
