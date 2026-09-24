/**
 * How long delivery takes, in days from the order being placed.
 *
 * SSLCommerz requires a live merchant site to state its delivery time, and
 * every shop on this marketplace ships from its own address with its own
 * courier arrangement - so the promise belongs to the shop, not the platform.
 * A shop sets its own window; a single product may override it when that one
 * item is slower or faster than the rest of the catalogue (made to order,
 * fragile, shipped from abroad).
 *
 * The resolution order is product -> shop -> the platform defaults below,
 * which are what every shop starts with and what an older row that predates
 * the columns falls back to.
 *
 * MUST match DELIVERY_WINDOW in the frontend (src/config/company.ts), which
 * is what the site-wide footer quotes where no shop is in context. Change
 * one, change the other.
 */
export const DELIVERY_DAYS = {
  /** Inside Dhaka, where the courier's own vans run. */
  inside: 5,
  /** Everywhere else in Bangladesh. */
  outside: 10,
} as const;

/** A window has to be at least a day, and anything past this is not a promise. */
export const MIN_DELIVERY_DAYS = 1;
export const MAX_DELIVERY_DAYS = 60;
