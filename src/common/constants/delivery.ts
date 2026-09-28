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

/* ── Where a shop delivers ─────────────────────────────────────────────
 * A shop either delivers across Bangladesh, priced in the two zones above
 * (inside Dhaka / everywhere else), or only inside one city - a bakery, a
 * florist, a grocer with its own rider. A city-only shop has no zones: it
 * charges one flat rate inside its city and does not take orders outside it.
 *
 * The shop sets the default; one product may override it either way (a
 * nationwide shop's fresh cakes that only go across Dhaka, or a local
 * shop's one parcel-friendly item). Resolution mirrors the delivery window:
 *
 *     the item's own choice, else the shop's.
 *
 * The item's city charge resolves on its own too - null follows the shop's
 * rate, so a seller who changes that rate moves every item still on it.
 *
 * MUST match `productDeliveryArea` in the frontend (composables/delivery.ts),
 * which is what the product page and cart quote before the API charges.
 */
export const DELIVERY_COVERAGES = ['nationwide', 'city'] as const;
export type DeliveryCoverage = (typeof DELIVERY_COVERAGES)[number];

/** What a city-only shop charges until it says otherwise (৳70, the same as
 *  the platform's inside-Dhaka rate). */
export const DEFAULT_CITY_DELIVERY_CENTS = 7000;

/**
 * The 64 districts, which is what a buyer picks as their "city" at checkout
 * (`address.area`). A city-only shop must name one of these, or no buyer
 * could ever match it. MUST match BD_CITIES in the frontend.
 */
export const BD_DISTRICTS = [
  'Dhaka',
  'Gazipur',
  'Narayanganj',
  'Tangail',
  'Narsingdi',
  'Munshiganj',
  'Manikganj',
  'Kishoreganj',
  'Faridpur',
  'Gopalganj',
  'Madaripur',
  'Rajbari',
  'Shariatpur',
  'Chattogram',
  "Cox's Bazar",
  'Cumilla',
  'Bandarban',
  'Brahmanbaria',
  'Chandpur',
  'Feni',
  'Khagrachhari',
  'Lakshmipur',
  'Noakhali',
  'Rangamati',
  'Rajshahi',
  'Bogura',
  'Joypurhat',
  'Naogaon',
  'Natore',
  'Chapai Nawabganj',
  'Pabna',
  'Sirajganj',
  'Khulna',
  'Bagerhat',
  'Chuadanga',
  'Jashore',
  'Jhenaidah',
  'Kushtia',
  'Magura',
  'Meherpur',
  'Narail',
  'Satkhira',
  'Barishal',
  'Barguna',
  'Bhola',
  'Jhalokati',
  'Patuakhali',
  'Pirojpur',
  'Sylhet',
  'Habiganj',
  'Moulvibazar',
  'Sunamganj',
  'Rangpur',
  'Dinajpur',
  'Gaibandha',
  'Kurigram',
  'Lalmonirhat',
  'Nilphamari',
  'Panchagarh',
  'Thakurgaon',
  'Mymensingh',
  'Jamalpur',
  'Netrokona',
  'Sherpur',
] as const;

/** Case, spacing and apostrophe style never make two districts different. */
function districtKey(name: string): string {
  return name.trim().toLowerCase().replace(/['’]/g, '').replace(/\s+/g, ' ');
}

/** The canonical spelling of a district, or null when it is not one. */
export function canonicalDistrict(
  name: string | null | undefined,
): string | null {
  if (!name?.trim()) return null;
  const key = districtKey(name);
  return BD_DISTRICTS.find((d) => districtKey(d) === key) ?? null;
}

/** Whether a buyer's district is the named city. */
export function sameDistrict(a: string, b: string): boolean {
  return districtKey(a) === districtKey(b);
}

/** The delivery fields a shop contributes to the resolution. */
export interface ShopDeliveryPolicy {
  deliveryCoverage: DeliveryCoverage;
  deliveryCity: string | null;
  deliveryCityCents: number;
}

/** The delivery fields a product contributes - null follows the shop. */
export interface ProductDeliveryPolicy {
  deliveryCoverage: DeliveryCoverage | null;
  deliveryCity: string | null;
  deliveryCityCents: number | null;
}

export type DeliveryArea =
  | { coverage: 'nationwide' }
  | { coverage: 'city'; city: string; cents: number };

/**
 * Where one product is delivered and, for a city-only item, what it costs.
 * A nationwide item is priced by its own zone charges, which this leaves to
 * the caller.
 *
 * A "city" with no city named cannot happen through the API (both writes
 * validate it), but a row that somehow has one is treated as nationwide
 * rather than as undeliverable everywhere.
 */
export function resolveDeliveryArea(
  product: ProductDeliveryPolicy,
  shop: ShopDeliveryPolicy,
): DeliveryArea {
  const ownCoverage = product.deliveryCoverage;
  const coverage = ownCoverage ?? shop.deliveryCoverage;
  if (coverage !== 'city') return { coverage: 'nationwide' };
  const city =
    ownCoverage === 'city' ? product.deliveryCity : shop.deliveryCity;
  if (!city) return { coverage: 'nationwide' };
  return {
    coverage: 'city',
    city,
    cents: product.deliveryCityCents ?? shop.deliveryCityCents,
  };
}
