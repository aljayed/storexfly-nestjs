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
  /** Inside the shop's own city (Dhaka for a shop that never chose). */
  inside: 5,
  /** Everywhere else in Bangladesh. */
  outside: 10,
} as const;

/** A window has to be at least a day, and anything past this is not a promise. */
export const MIN_DELIVERY_DAYS = 1;
export const MAX_DELIVERY_DAYS = 60;

/* ── Where a shop delivers from, and to ───────────────────────────────
 * Every shop dispatches from one city - `deliveryCity`, one of the 64
 * districts, Dhaka until the seller says otherwise. Delivery is priced in two
 * zones around it: inside that city, and everywhere else in Bangladesh. The
 * delivery window (DELIVERY_DAYS above) splits the same way.
 *
 * A shop may also deliver only inside its city (a bakery, a florist, a grocer
 * with its own rider): then there is no outside zone and it takes no orders
 * from anywhere else.
 *
 * The shop sets the defaults - the coverage and both charges - and one item
 * may override either. Resolution mirrors the delivery window:
 *
 *     the item's own choice, else the shop's, else the platform's.
 *
 * Each charge resolves on its own, so a null on the item means "whatever my
 * shop charges", and a seller who changes the shop's rates moves every item
 * still on them.
 *
 * MUST match `productDelivery` in the frontend (composables/delivery.ts),
 * which is what the product page and cart quote before the API charges.
 */
export const DELIVERY_COVERAGES = ['nationwide', 'city'] as const;
export type DeliveryCoverage = (typeof DELIVERY_COVERAGES)[number];

/** Where a shop dispatches from until it says otherwise - and the city every
 *  zone charge was measured from before shops could choose. */
export const DEFAULT_DELIVERY_CITY = 'Dhaka';

/** What a shop charges until it sets its own rates (৳70 inside its city,
 *  ৳120 outside). MUST match DEFAULT_*_FEE in the frontend. */
export const DEFAULT_INSIDE_CENTS = 7000;
export const DEFAULT_OUTSIDE_CENTS = 12000;

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
  deliveryCity: string;
  deliveryInsideCents: number;
  deliveryOutsideCents: number;
}

/** The delivery fields a product contributes - null follows the shop.
 *  `deliveryDhakaCents` is the inside-the-shop's-city charge; the column
 *  predates shops choosing a city, when that city was always Dhaka. */
export interface ProductDeliveryPolicy {
  deliveryCoverage: DeliveryCoverage | null;
  deliveryDhakaCents: number | null;
  deliveryOutsideCents: number | null;
}

/** One item, placed: where it can go and what each zone costs. */
export interface ResolvedDelivery {
  coverage: DeliveryCoverage;
  /** The shop's dispatch city - the inside zone, and a city-only item's limit. */
  city: string;
  insideCents: number;
  outsideCents: number;
}

export function resolveDelivery(
  product: ProductDeliveryPolicy,
  shop: ShopDeliveryPolicy,
): ResolvedDelivery {
  return {
    coverage: product.deliveryCoverage ?? shop.deliveryCoverage,
    city: shop.deliveryCity || DEFAULT_DELIVERY_CITY,
    insideCents: product.deliveryDhakaCents ?? shop.deliveryInsideCents,
    outsideCents: product.deliveryOutsideCents ?? shop.deliveryOutsideCents,
  };
}

/**
 * What one item costs to deliver to a buyer's district, or null when it
 * cannot go there at all - a city-only item, anywhere but its city.
 */
export function deliveryCentsTo(
  delivery: ResolvedDelivery,
  district: string,
): number | null {
  const inside = sameDistrict(district, delivery.city);
  if (delivery.coverage === 'city') return inside ? delivery.insideCents : null;
  return inside ? delivery.insideCents : delivery.outsideCents;
}
