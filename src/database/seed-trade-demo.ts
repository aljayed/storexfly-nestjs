import 'dotenv/config';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { and, eq, inArray, notLike, or } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { COMMISSION_BPS } from '../common/constants/billing';
import { BRAND_SWATCHES } from '../common/constants/brand-swatches';
import type { CommercePolicy } from '../common/commerce/commerce';
import { handleize } from '../common/utils/slug.util';
import { generatePublicId } from '../common/utils/public-id.util';
import * as schema from './schema';
import type { OrderStatus, PaymentStatus, ProductTag } from './schema/enums';

/**
 * Demo data for the three business types: a B2C retail shop, a B2B wholesale
 * supplier, and a reseller carrying that supplier's products - linked the way
 * real trade is (listings, reseller orders, quotes, a dispute), so every
 * trade console screen has something to show.
 *
 *   node dist/src/database/seed-trade-demo.js --force           # (re)create
 *   node dist/src/database/seed-trade-demo.js --force --remove  # take it out
 *   ... --dry-run   # do all of it inside the transaction, then roll back
 *
 * Scoped like seed.ts: it only ever touches its own `demo-` shop handles and
 * `@example.com` accounts. Re-running replaces the previous demo set with a
 * fresh one dated around "now" (orders age past their platform deadlines in
 * a few days, so re-run to refresh).
 *
 * Safety, because these shops are public:
 *  - Every contact is unreachable: emails on example.com (reserved, never
 *    delivered) and phones on the unassigned 010 prefix.
 *  - Owner passwords are random per run and printed once - never a known one.
 *  - Cleanup refuses to delete any order or quote it did not create (a real
 *    visitor's purchase from a demo shop), naming them instead.
 */

const DOMAIN = 'example.com';
const HANDLES = {
  retail: 'demo-dhaka-daily',
  wholesale: 'demo-shapla-textiles',
  reseller: 'demo-trendy-corner',
} as const;
const OWNERS = {
  retail: { email: `demo.retail@${DOMAIN}`, name: 'Farhana Akter (Demo)' },
  wholesale: { email: `demo.supplier@${DOMAIN}`, name: 'Kamal Hossain (Demo)' },
  reseller: { email: `demo.reseller@${DOMAIN}`, name: 'Tania Sultana (Demo)' },
} as const;
const BUYERS = {
  rahim: {
    email: `demo.rahim.traders@${DOMAIN}`,
    name: 'Rahim Traders',
    person: 'Rahim Uddin',
    area: 'Chattogram',
  },
  nadia: {
    email: `demo.nadia.boutique@${DOMAIN}`,
    name: 'Nadia Boutique',
    person: 'Nadia Islam',
    area: 'Sylhet',
  },
} as const;
const DEMO_EMAILS = [...Object.values(OWNERS), ...Object.values(BUYERS)].map(
  (u) => u.email,
);

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms);
const ahead = (ms: number) => new Date(NOW + ms);
const cents = (taka: number) => Math.round(taka * 100);
let phoneSeq = 0;
/** 010 is not an assigned Bangladeshi operator prefix: well-formed, unreachable. */
const fakePhone = () => `010000${String(++phoneSeq).padStart(5, '0')}`;
const password = () => randomBytes(12).toString('base64url');

type Tx = Parameters<
  Parameters<ReturnType<typeof drizzle<typeof schema>>['transaction']>[0]
>[0];

/* ── Catalogues ─────────────────────────────────────────────────── */

interface Item {
  name: string;
  cat: string;
  price: number;
  unit: string;
  stock: number;
  emoji: string;
  tone: string;
  tag?: ProductTag;
  rating: number;
  reviews: number;
  blurb: string;
  /** Trade terms in taka; omitted = retail only. */
  reseller?: number;
  moq?: number;
  tiers?: [number, number][];
}

const RETAIL_ITEMS: Item[] = [
  {
    name: 'Chinigura Aromatic Rice 5kg',
    cat: 'Rice & grains',
    price: 780,
    unit: '5 kg bag',
    stock: 60,
    emoji: '🍚',
    tone: '#f6f0e4',
    tag: 'Bestseller',
    rating: 4.8,
    reviews: 124,
    blurb:
      'Small-grain, naturally fragrant rice from Dinajpur - the one for polao and payesh.',
  },
  {
    name: 'Sundarbans Raw Honey',
    cat: 'Honey',
    price: 650,
    unit: '500 g jar',
    stock: 35,
    emoji: '🍯',
    tone: '#fbeede',
    rating: 4.9,
    reviews: 88,
    blurb:
      'Wild khalisha honey collected by mawals in the Sundarbans. Unheated, unfiltered.',
  },
  {
    name: 'Cold-Pressed Mustard Oil',
    cat: 'Oil',
    price: 340,
    unit: '1 litre',
    stock: 48,
    emoji: '🫒',
    tone: '#f3f3dc',
    rating: 4.7,
    reviews: 61,
    blurb: 'Ghani-pressed from Sirajganj mustard seed. Sharp, golden and pure.',
  },
  {
    name: 'Premium Ajwa Dates',
    cat: 'Dry fruits',
    price: 990,
    unit: '500 g box',
    stock: 22,
    emoji: '🌴',
    tone: '#efe4dc',
    tag: 'Gift',
    rating: 4.9,
    reviews: 47,
    blurb:
      'Soft Madinah Ajwa dates, packed in a gift box. A favourite for Ramadan and visits.',
  },
  {
    name: 'Sylhet Garden Black Tea',
    cat: 'Tea',
    price: 420,
    unit: '400 g pack',
    stock: 70,
    emoji: '🍵',
    tone: '#e2f1e8',
    rating: 4.6,
    reviews: 39,
    blurb: 'Strong, bright CTC tea from Srimangal estates. Made for milk tea.',
  },
  {
    name: 'Nakshi Kantha Cushion Cover',
    cat: 'Home',
    price: 1250,
    unit: '16 x 16 in',
    stock: 12,
    emoji: '🧵',
    tone: '#fbe4ee',
    tag: 'New',
    rating: 5,
    reviews: 9,
    blurb:
      'Hand-stitched by artisans in Jamalpur. Every piece is slightly different.',
  },
  {
    name: 'Organic Turmeric Powder',
    cat: 'Spices',
    price: 180,
    unit: '200 g pack',
    stock: 3,
    emoji: '🟡',
    tone: '#fdf3d6',
    rating: 4.8,
    reviews: 52,
    blurb: 'Sun-dried and stone-ground in Rangpur. Deep colour, no additives.',
  },
  {
    name: 'Masala Chanachur',
    cat: 'Snacks',
    price: 120,
    unit: '350 g pack',
    stock: 140,
    emoji: '🥜',
    tone: '#f8e3dc',
    tag: 'Snack',
    rating: 4.5,
    reviews: 210,
    blurb:
      'The tea-time classic: crunchy, spicy and impossible to stop eating.',
  },
];

const SUPPLIER_ITEMS: Item[] = [
  {
    name: "Men's Cotton Panjabi",
    cat: 'Menswear',
    price: 1650,
    unit: 'piece',
    stock: 900,
    emoji: '👔',
    tone: '#e9eefc',
    tag: 'Bestseller',
    rating: 4.7,
    reviews: 64,
    blurb:
      'Breathable combed cotton with a classic band collar. Sizes M to XXL, five colours.',
    reseller: 1100,
    moq: 20,
    tiers: [
      [20, 950],
      [100, 850],
      [500, 760],
    ],
  },
  {
    name: "Women's Printed Three-Piece",
    cat: 'Womenswear',
    price: 2200,
    unit: 'set',
    stock: 420,
    emoji: '👗',
    tone: '#fbe4ee',
    rating: 4.8,
    reviews: 41,
    blurb:
      'Kameez, salwar and orna in soft lawn cotton with screen-printed motifs.',
    reseller: 1450,
    moq: 10,
    tiers: [
      [10, 1300],
      [50, 1180],
      [200, 1050],
    ],
  },
  {
    name: 'Cotton Check Lungi (Pack of 2)',
    cat: 'Menswear',
    price: 750,
    unit: 'pack of 2',
    stock: 1200,
    emoji: '🧺',
    tone: '#e2f1e8',
    rating: 4.6,
    reviews: 120,
    blurb:
      'Yarn-dyed checks from Narsingdi looms. Colourfast and soft after the first wash.',
    reseller: 480,
    moq: 30,
    tiers: [
      [30, 420],
      [150, 380],
    ],
  },
  {
    name: "Kids' Cotton T-Shirt",
    cat: 'Kidswear',
    price: 450,
    unit: 'piece',
    stock: 2400,
    emoji: '👕',
    tone: '#fdf3d6',
    tag: 'New',
    rating: 4.5,
    reviews: 33,
    blurb: 'Single-jersey cotton, tagless neck, ages 2 to 12. Eight prints.',
    reseller: 290,
    moq: 50,
    tiers: [
      [50, 240],
      [300, 210],
    ],
  },
  {
    name: 'Jamdani-Pattern Cotton Saree',
    cat: 'Womenswear',
    price: 4800,
    unit: 'piece',
    stock: 8,
    emoji: '🥻',
    tone: '#ebe6f8',
    tag: 'Gift',
    rating: 4.9,
    reviews: 18,
    blurb:
      'Machine-woven with traditional Jamdani motifs. Comes with blouse piece.',
    reseller: 3400,
    moq: 5,
    tiers: [
      [5, 3100],
      [25, 2850],
    ],
  },
  {
    name: 'Hand-Woven Gamcha (Set of 3)',
    cat: 'Home textiles',
    price: 390,
    unit: 'set of 3',
    stock: 3000,
    emoji: '🧣',
    tone: '#f8e3dc',
    rating: 4.7,
    reviews: 76,
    blurb:
      'Thin, quick-drying red-and-white check towels from Kushtia weavers.',
    reseller: 250,
    moq: 50,
    tiers: [
      [50, 210],
      [500, 180],
    ],
  },
  {
    name: 'Linen-Blend Casual Shirt',
    cat: 'Menswear',
    price: 1450,
    unit: 'piece',
    stock: 0,
    emoji: '🎽',
    tone: '#e9eefc',
    rating: 4.4,
    reviews: 12,
    blurb: 'Cool linen-cotton weave with a relaxed fit. Restocking soon.',
    reseller: 950,
    moq: 20,
    tiers: [[20, 880]],
  },
  {
    name: 'Embroidered Winter Shawl',
    cat: 'Womenswear',
    price: 1800,
    unit: 'piece',
    stock: 140,
    emoji: '🧶',
    tone: '#fbeede',
    rating: 4.8,
    reviews: 22,
    blurb:
      'Warm acrylic-wool blend with hand-finished embroidery. Wholesale only for trade buyers.',
    moq: 10,
    tiers: [
      [10, 1250],
      [60, 1120],
    ],
  },
  {
    name: 'Stretch Denim Jeans',
    cat: 'Menswear',
    price: 1900,
    unit: 'piece',
    stock: 75,
    emoji: '👖',
    tone: '#e9eefc',
    rating: 4.3,
    reviews: 27,
    blurb: 'Mid-rise, slim fit, 2% stretch. Sold in our own store only.',
  },
];

/** What the reseller carries, at its own price; `active: false` = paused. */
const RESELL: { item: string; price: number; active?: boolean }[] = [
  { item: "Men's Cotton Panjabi", price: 1490 },
  { item: "Women's Printed Three-Piece", price: 1950 },
  { item: "Kids' Cotton T-Shirt", price: 390 },
  { item: 'Cotton Check Lungi (Pack of 2)', price: 499 }, // thin margin
  { item: 'Linen-Blend Casual Shirt', price: 1290 }, // supplier out of stock
  { item: 'Hand-Woven Gamcha (Set of 3)', price: 349, active: false },
  { item: 'Jamdani-Pattern Cotton Saree', price: 4390 },
];

const PEOPLE = [
  ['Ayesha Siddiqua', 'Dhanmondi, Dhaka'],
  ['Tanvir Ahmed', 'Mirpur, Dhaka'],
  ['Sadia Rahman', 'Uttara, Dhaka'],
  ['Mehedi Hasan', 'Agrabad, Chattogram'],
  ['Nusrat Jahan', 'Zindabazar, Sylhet'],
  ['Rafiq Islam', 'Sonadanga, Khulna'],
  ['Shirin Akter', 'Gulshan, Dhaka'],
  ['Imran Kabir', 'Shaheb Bazar, Rajshahi'],
  ['Laila Begum', 'Mohammadpur, Dhaka'],
  ['Arif Chowdhury', 'Nasirabad, Chattogram'],
  ['Joya Das', 'Bashundhara, Dhaka'],
  ['Sabbir Hossain', 'Kotwali, Barishal'],
] as const;

/* ── Order plans ────────────────────────────────────────────────── */

interface Plan {
  status: OrderStatus;
  /** Age of the order. Kept inside the platform deadlines (see order-deadlines.ts). */
  age: number;
  pay: 'cod' | 'card';
  person: number;
  lines: [string, number][];
}

// Retail: a month of ordinary trade across every pipeline stage.
const RETAIL_PLANS: Plan[] = [
  {
    status: 'New',
    age: 2 * HOUR,
    pay: 'cod',
    person: 0,
    lines: [
      ['Chinigura Aromatic Rice 5kg', 1],
      ['Masala Chanachur', 2],
    ],
  },
  {
    status: 'New',
    age: 9 * HOUR,
    pay: 'card',
    person: 1,
    lines: [['Sundarbans Raw Honey', 2]],
  },
  {
    status: 'New',
    age: 30 * HOUR,
    pay: 'cod',
    person: 2,
    lines: [['Premium Ajwa Dates', 1]],
  },
  {
    status: 'Confirmed',
    age: 1.5 * DAY,
    pay: 'cod',
    person: 3,
    lines: [
      ['Cold-Pressed Mustard Oil', 2],
      ['Organic Turmeric Powder', 1],
    ],
  },
  {
    status: 'Packed',
    age: 2 * DAY,
    pay: 'card',
    person: 4,
    lines: [['Sylhet Garden Black Tea', 2]],
  },
  {
    status: 'HandedOver',
    age: 3 * DAY,
    pay: 'cod',
    person: 5,
    lines: [['Nakshi Kantha Cushion Cover', 2]],
  },
  {
    status: 'Shipped',
    age: 4 * DAY,
    pay: 'card',
    person: 6,
    lines: [
      ['Premium Ajwa Dates', 2],
      ['Sundarbans Raw Honey', 1],
    ],
  },
  {
    status: 'Delivered',
    age: 5 * DAY,
    pay: 'cod',
    person: 0,
    lines: [['Chinigura Aromatic Rice 5kg', 2]],
  },
  {
    status: 'Delivered',
    age: 6 * DAY,
    pay: 'card',
    person: 7,
    lines: [['Masala Chanachur', 4]],
  },
  {
    status: 'Delivered',
    age: 8 * DAY,
    pay: 'cod',
    person: 8,
    lines: [
      ['Cold-Pressed Mustard Oil', 1],
      ['Sylhet Garden Black Tea', 1],
    ],
  },
  {
    status: 'Cancelled',
    age: 9 * DAY,
    pay: 'cod',
    person: 9,
    lines: [['Organic Turmeric Powder', 2]],
  },
  {
    status: 'Delivered',
    age: 10 * DAY,
    pay: 'cod',
    person: 1,
    lines: [
      ['Sundarbans Raw Honey', 1],
      ['Premium Ajwa Dates', 1],
    ],
  },
  {
    status: 'Delivered',
    age: 12 * DAY,
    pay: 'card',
    person: 10,
    lines: [['Nakshi Kantha Cushion Cover', 1]],
  },
  {
    status: 'Delivered',
    age: 13 * DAY,
    pay: 'cod',
    person: 0,
    lines: [
      ['Chinigura Aromatic Rice 5kg', 1],
      ['Cold-Pressed Mustard Oil', 1],
    ],
  },
  {
    status: 'Delivered',
    age: 16 * DAY,
    pay: 'cod',
    person: 11,
    lines: [['Masala Chanachur', 3]],
  },
  {
    status: 'Delivered',
    age: 19 * DAY,
    pay: 'card',
    person: 6,
    lines: [['Premium Ajwa Dates', 3]],
  },
  {
    status: 'Delivered',
    age: 22 * DAY,
    pay: 'cod',
    person: 2,
    lines: [['Sylhet Garden Black Tea', 3]],
  },
  {
    status: 'Delivered',
    age: 26 * DAY,
    pay: 'cod',
    person: 3,
    lines: [
      ['Chinigura Aromatic Rice 5kg', 2],
      ['Masala Chanachur', 1],
    ],
  },
];

// Customers of the reseller's store, fulfilled by the supplier.
const RESELL_PLANS: Plan[] = [
  {
    status: 'New',
    age: 3 * HOUR,
    pay: 'card',
    person: 4,
    lines: [["Men's Cotton Panjabi", 2]],
  },
  {
    status: 'Confirmed',
    age: 1 * DAY,
    pay: 'card',
    person: 8,
    lines: [["Women's Printed Three-Piece", 1]],
  },
  {
    status: 'Packed',
    age: 2 * DAY,
    pay: 'card',
    person: 10,
    lines: [["Kids' Cotton T-Shirt", 3]],
  },
  {
    status: 'Shipped',
    age: 3 * DAY,
    pay: 'card',
    person: 1,
    lines: [["Men's Cotton Panjabi", 1]],
  },
  {
    status: 'Delivered',
    age: 5 * DAY,
    pay: 'card',
    person: 2,
    lines: [["Women's Printed Three-Piece", 2]],
  },
  {
    status: 'Delivered',
    age: 7 * DAY,
    pay: 'card',
    person: 6,
    lines: [['Jamdani-Pattern Cotton Saree', 1]],
  },
  {
    status: 'Delivered',
    age: 9 * DAY,
    pay: 'card',
    person: 11,
    lines: [["Men's Cotton Panjabi", 3]],
  },
  {
    status: 'Delivered',
    age: 12 * DAY,
    pay: 'card',
    person: 5,
    lines: [["Kids' Cotton T-Shirt", 4]],
  },
  {
    status: 'Cancelled',
    age: 13 * DAY,
    pay: 'card',
    person: 9,
    lines: [['Cotton Check Lungi (Pack of 2)', 1]],
  },
  {
    status: 'Delivered',
    age: 18 * DAY,
    pay: 'card',
    person: 0,
    lines: [
      ["Women's Printed Three-Piece", 1],
      ["Kids' Cotton T-Shirt", 2],
    ],
  },
];

// Bulk orders from business buyers at tier prices.
const WHOLESALE_PLANS: (Omit<Plan, 'person'> & {
  buyer: keyof typeof BUYERS;
  quote?: true;
  dispute?: string;
})[] = [
  {
    status: 'New',
    age: 5 * HOUR,
    pay: 'card',
    buyer: 'nadia',
    lines: [["Women's Printed Three-Piece", 50]],
  },
  {
    status: 'Confirmed',
    age: 1 * DAY,
    pay: 'card',
    buyer: 'rahim',
    lines: [
      ["Men's Cotton Panjabi", 120],
      ['Cotton Check Lungi (Pack of 2)', 150],
    ],
    quote: true,
  },
  {
    status: 'Packed',
    age: 2 * DAY,
    pay: 'cod',
    buyer: 'rahim',
    lines: [["Kids' Cotton T-Shirt", 300]],
  },
  {
    status: 'Shipped',
    age: 4 * DAY,
    pay: 'card',
    buyer: 'nadia',
    lines: [['Embroidered Winter Shawl', 60]],
  },
  {
    status: 'Delivered',
    age: 8 * DAY,
    pay: 'card',
    buyer: 'rahim',
    lines: [['Hand-Woven Gamcha (Set of 3)', 500]],
    dispute:
      '18 of the 500 gamcha sets arrived with loose stitching along the hem. Photos sent on chat - please replace or credit them.',
  },
  {
    status: 'Delivered',
    age: 15 * DAY,
    pay: 'card',
    buyer: 'nadia',
    lines: [["Women's Printed Three-Piece", 200]],
  },
  {
    status: 'Delivered',
    age: 24 * DAY,
    pay: 'card',
    buyer: 'rahim',
    lines: [["Men's Cotton Panjabi", 100]],
  },
];

/* ── Cleanup ────────────────────────────────────────────────────── */

async function clear(tx: Tx): Promise<void> {
  const shops = await tx
    .select({ id: schema.shops.id })
    .from(schema.shops)
    .where(inArray(schema.shops.handle, Object.values(HANDLES)));
  const users = await tx
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(inArray(schema.users.email, DEMO_EMAILS));
  const shopIds = shops.map((s) => s.id);
  const userIds = users.map((u) => u.id);
  if (!shopIds.length && !userIds.length) return;
  const productIds = shopIds.length
    ? (
        await tx
          .select({ id: schema.products.id })
          .from(schema.products)
          .where(inArray(schema.products.shopId, shopIds))
      ).map((p) => p.id)
    : [];
  const none = ['00000000-0000-0000-0000-000000000000'];
  const S = shopIds.length ? shopIds : none;
  const U = userIds.length ? userIds : none;
  const P = productIds.length ? productIds : none;

  const listings = await tx
    .select({
      id: schema.resellerListings.id,
      shopId: schema.resellerListings.shopId,
    })
    .from(schema.resellerListings)
    .where(
      or(
        inArray(schema.resellerListings.shopId, S),
        inArray(schema.resellerListings.productId, P),
      ),
    );
  const quotes = await tx
    .select({ id: schema.tradeQuotes.id, buyerId: schema.tradeQuotes.buyerId })
    .from(schema.tradeQuotes)
    .where(
      or(
        inArray(schema.tradeQuotes.shopId, S),
        inArray(schema.tradeQuotes.productId, P),
        inArray(schema.tradeQuotes.buyerId, U),
      ),
    );
  const L = listings.length ? listings.map((l) => l.id) : none;
  const Q = quotes.length ? quotes.map((q) => q.id) : none;
  const touching = or(
    inArray(schema.orders.shopId, S),
    inArray(schema.orders.resellerShopId, S),
    inArray(schema.orders.resellerListingId, L),
    inArray(schema.orders.tradeQuoteId, Q),
    inArray(schema.orders.userId, U),
  );

  // Never delete what a real person did with a demo shop.
  const foreign = await tx
    .select({ reference: schema.orders.reference, email: schema.orders.email })
    .from(schema.orders)
    .where(and(touching, notLike(schema.orders.email, `%@${DOMAIN}`)));
  const foreignQuotes = quotes.filter((q) => !userIds.includes(q.buyerId));
  if (foreign.length || foreignQuotes.length) {
    throw new Error(
      `Refusing to clear the demo set: ${foreign.length} order(s) and ${foreignQuotes.length} quote(s) involve real accounts ` +
        `(${foreign.map((o) => o.reference).join(', ')}). Handle them by hand first.`,
    );
  }
  const foreignListings = listings.filter((l) => !shopIds.includes(l.shopId));
  if (foreignListings.length)
    console.log(
      `  Note: removing ${foreignListings.length} listing(s) other shops made of demo products.`,
    );

  const orderIds = (
    await tx
      .select({ id: schema.orders.id })
      .from(schema.orders)
      .where(touching)
  ).map((o) => o.id);
  const O = orderIds.length ? orderIds : none;
  await tx
    .delete(schema.tradeDisputes)
    .where(
      or(
        inArray(schema.tradeDisputes.orderId, O),
        inArray(schema.tradeDisputes.shopId, S),
        inArray(schema.tradeDisputes.buyerId, U),
      ),
    );
  await tx.delete(schema.orders).where(inArray(schema.orders.id, O));
  await tx.delete(schema.tradeQuotes).where(inArray(schema.tradeQuotes.id, Q));
  await tx
    .delete(schema.resellerListings)
    .where(inArray(schema.resellerListings.id, L));
  if (shopIds.length)
    await tx.delete(schema.shops).where(inArray(schema.shops.id, shopIds));
  if (userIds.length)
    await tx.delete(schema.users).where(inArray(schema.users.id, userIds));
  console.log(
    `  Cleared ${shopIds.length} demo shop(s), ${userIds.length} account(s), ${orderIds.length} order(s).`,
  );
}

/* ── Seeding ────────────────────────────────────────────────────── */

async function createUser(
  tx: Tx,
  u: { email: string; name: string },
  pass?: string,
) {
  const [row] = await tx
    .insert(schema.users)
    .values({
      publicId: generatePublicId(),
      name: u.name,
      email: u.email,
      phone: fakePhone(),
      passwordHash: pass ? await bcrypt.hash(pass, 12) : null,
      via: 'email',
      emailVerified: true,
      phoneVerified: true,
    })
    .returning();
  return row;
}

async function createShop(
  tx: Tx,
  ownerId: string,
  v: {
    name: string;
    handle: string;
    tagline: string;
    cat: string;
    swatch: keyof typeof BRAND_SWATCHES;
    type: 'retail' | 'wholesale' | 'reseller';
    verified?: boolean;
  },
) {
  const sw = BRAND_SWATCHES[v.swatch];
  const [shop] = await tx
    .insert(schema.shops)
    .values({
      name: v.name,
      handle: v.handle,
      tagline: v.tagline,
      cat: v.cat as never,
      brandId: v.swatch,
      brand: sw.c,
      brandSoft: sw.soft,
      ownerId,
      businessType: v.type,
      paymentMethods: ['card', 'cod'],
      supportPhone: fakePhone(),
      supportEmail: `support.${v.handle}@${DOMAIN}`,
      kycStatus: v.verified ? 'verified' : 'unsubmitted',
    })
    .returning();
  // Paid plan with credit: a free shop deactivates at 10 lifetime orders,
  // which would switch the demo off mid-tour.
  await tx.insert(schema.subscriptions).values({
    shopId: shop.id,
    ownerId,
    status: 'active',
    billingMode: 'credits',
    currency: 'BDT',
    commissionBps: COMMISSION_BPS,
    creditGrantedCents: cents(500_000),
    meterStartAt: ago(40 * DAY),
    startedAt: ago(40 * DAY),
    nextBillingAt: ahead(20 * DAY),
  });
  return shop;
}

async function createProducts(tx: Tx, shopId: string, items: Item[]) {
  const out = new Map<string, { id: string; item: Item }>();
  for (const it of items) {
    const channels: CommercePolicy['channels'] = ['retail'];
    if (it.reseller != null) channels.push('reseller');
    if (it.tiers) channels.push('wholesale');
    const commerce: CommercePolicy = { channels };
    if (it.reseller != null) commerce.resellerPriceCents = cents(it.reseller);
    if (it.tiers) {
      commerce.wholesaleMoq = it.moq ?? it.tiers[0][0];
      commerce.wholesaleTiers = it.tiers.map(([minQty, p]) => ({
        minQty,
        unitPriceCents: cents(p),
      }));
    }
    const [row] = await tx
      .insert(schema.products)
      .values({
        shopId,
        name: it.name,
        slug: handleize(it.name),
        cat: it.cat,
        priceCents: cents(it.price),
        unit: it.unit,
        stock: it.stock,
        emoji: it.emoji,
        tone: it.tone,
        tag: it.tag,
        rating: it.rating,
        reviewsCount: it.reviews,
        blurb: it.blurb,
        commerce,
        createdAt: ago(35 * DAY),
      })
      .returning({ id: schema.products.id });
    out.set(it.name, { id: row.id, item: it });
  }
  return out;
}

/** Timestamps an order at `status` would carry, kept inside its deadlines. */
function lifecycle(
  status: OrderStatus,
  placedAt: Date,
  payMethod: 'cod' | 'card',
) {
  const at = (h: number) =>
    new Date(Math.min(placedAt.getTime() + h * HOUR, NOW - 10 * 60_000));
  const reached = (s: OrderStatus[]) => s.includes(status);
  const paid: PaymentStatus =
    payMethod === 'card' || status === 'Delivered' ? 'Paid' : 'Due';
  return {
    pay:
      status === 'Cancelled' && payMethod === 'card'
        ? ('Refunded' as const)
        : paid,
    confirmedAt: reached([
      'Confirmed',
      'Packed',
      'HandedOver',
      'Shipped',
      'Delivered',
    ])
      ? at(3)
      : null,
    handedOverAt: reached(['HandedOver', 'Shipped', 'Delivered'])
      ? at(26)
      : null,
    deliveredAt: status === 'Delivered' ? at(70) : null,
    cancelledAt: status === 'Cancelled' ? at(5) : null,
    cancelReason: status === 'Cancelled' ? ('seller' as const) : null,
    courierTrackingCode: reached(['HandedOver', 'Shipped', 'Delivered'])
      ? `DM${String(placedAt.getTime()).slice(-8)}`
      : null,
  };
}

interface Built {
  shopId: string;
  name: string;
  email: string;
  phone: string;
  area: string;
  totalCents: number;
  placedAt: Date;
}

async function seed(): Promise<void> {
  const force = process.argv.includes('--force');
  const remove = process.argv.includes('--remove');
  const dryRun = process.argv.includes('--dry-run');
  if (process.env.NODE_ENV === 'production' && !force) {
    console.error(
      'Refusing to run against NODE_ENV=production without --force.',
    );
    process.exit(1);
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const client = postgres(url, { max: 1 });
  const db = drizzle(client, { schema });
  const passwords: Record<string, string> = {};

  try {
    await db.transaction(async (tx) => {
      console.log(
        'Clearing the previous demo set (demo- handles, @example.com accounts only)…',
      );
      await clear(tx);
      if (remove) return;

      console.log('Creating accounts…');
      const owners = {} as Record<
        keyof typeof OWNERS,
        typeof schema.users.$inferSelect
      >;
      for (const k of Object.keys(OWNERS) as (keyof typeof OWNERS)[]) {
        passwords[OWNERS[k].email] = password();
        owners[k] = await createUser(tx, OWNERS[k], passwords[OWNERS[k].email]);
      }
      const buyers = {} as Record<
        keyof typeof BUYERS,
        typeof schema.users.$inferSelect
      >;
      for (const k of Object.keys(BUYERS) as (keyof typeof BUYERS)[])
        buyers[k] = await createUser(tx, {
          email: BUYERS[k].email,
          name: BUYERS[k].person,
        });

      console.log('Creating shops…');
      const retail = await createShop(tx, owners.retail.id, {
        name: 'Dhaka Daily Mart',
        handle: HANDLES.retail,
        tagline:
          'Pantry staples and local favourites, delivered across Bangladesh.',
        cat: 'Food & grocery',
        swatch: 'amber',
        type: 'retail',
      });
      const supplier = await createShop(tx, owners.wholesale.id, {
        name: 'Shapla Textiles',
        handle: HANDLES.wholesale,
        tagline:
          'Narsingdi-made clothing at factory prices, for shops and resellers.',
        cat: 'Fashion',
        swatch: 'blue',
        type: 'wholesale',
        verified: true,
      });
      const reseller = await createShop(tx, owners.reseller.id, {
        name: 'Trendy Corner BD',
        handle: HANDLES.reseller,
        tagline: 'Hand-picked everyday fashion, delivered to your door.',
        cat: 'Fashion',
        swatch: 'rose',
        type: 'reseller',
      });

      console.log('Creating catalogues…');
      const retailProducts = await createProducts(tx, retail.id, RETAIL_ITEMS);
      const supplierProducts = await createProducts(
        tx,
        supplier.id,
        SUPPLIER_ITEMS,
      );

      console.log('Creating reviews…');
      const reviewLines: [string, string, number, string][] = [
        [
          'Chinigura Aromatic Rice 5kg',
          'Ayesha Siddiqua',
          5,
          'Exactly like the rice from my grandmother’s village. The polao smelled amazing.',
        ],
        [
          'Chinigura Aromatic Rice 5kg',
          'Mehedi Hasan',
          4,
          'Good quality, delivery took two days to Chattogram.',
        ],
        [
          'Sundarbans Raw Honey',
          'Tanvir Ahmed',
          5,
          'Thick and real. You can taste the difference from supermarket honey.',
        ],
        [
          'Premium Ajwa Dates',
          'Shirin Akter',
          5,
          'Beautiful box, perfect as a gift for my in-laws.',
        ],
        [
          "Men's Cotton Panjabi",
          'Imran Kabir',
          5,
          'Comfortable fabric, stitching is clean. Bought two more for Eid.',
        ],
        [
          "Women's Printed Three-Piece",
          'Joya Das',
          4,
          'Colours are lovely, the orna is a bit thin but fine for summer.',
        ],
      ];
      for (const [name, author, rating, body] of reviewLines) {
        const p = retailProducts.get(name) ?? supplierProducts.get(name)!;
        await tx.insert(schema.reviews).values({
          productId: p.id,
          author,
          rating,
          body,
          verified: true,
          createdAt: ago(
            (3 + reviewLines.indexOf(reviewLines.find((r) => r[0] === name)!)) *
              DAY,
          ),
        });
      }

      console.log('Listing supplier products in the reseller store…');
      const listingByItem = new Map<
        string,
        { id: string; sellCents: number; supplyCents: number }
      >();
      for (const r of RESELL) {
        const p = supplierProducts.get(r.item)!;
        const [row] = await tx
          .insert(schema.resellerListings)
          .values({
            shopId: reseller.id,
            productId: p.id,
            sellingPriceCents: cents(r.price),
            active: r.active ?? true,
            createdAt: ago(30 * DAY),
          })
          .returning({ id: schema.resellerListings.id });
        listingByItem.set(r.item, {
          id: row.id,
          sellCents: cents(r.price),
          supplyCents: cents(p.item.reseller!),
        });
      }

      const built: Built[] = [];
      const refs = new Map<string, number>();
      const nextRef = (shopId: string) => {
        const n = (refs.get(shopId) ?? 1000) + 1;
        refs.set(shopId, n);
        return `#${n}`;
      };
      const person = (i: number) => {
        const [name, area] = PEOPLE[i % PEOPLE.length];
        return {
          name,
          area,
          email: `demo.${handleize(name)}@${DOMAIN}`,
          phone: `0100001${String(i).padStart(4, '0')}`,
        };
      };

      // Oldest first, so references read in the order things happened.
      console.log('Creating retail orders…');
      for (const plan of [...RETAIL_PLANS].sort((a, b) => b.age - a.age)) {
        const who = person(plan.person);
        const placedAt = ago(plan.age);
        const lines = plan.lines.map(([n, qty]) => ({
          p: retailProducts.get(n)!,
          qty,
        }));
        const deliveryCents = who.area.includes('Dhaka')
          ? cents(60)
          : cents(120);
        const goods = lines.reduce(
          (s, l) => s + cents(l.p.item.price) * l.qty,
          0,
        );
        const life = lifecycle(plan.status, placedAt, plan.pay);
        const [order] = await tx
          .insert(schema.orders)
          .values({
            reference: nextRef(retail.id),
            shopId: retail.id,
            customerName: who.name,
            email: who.email,
            phone: who.phone,
            qty: lines.reduce((s, l) => s + l.qty, 0),
            totalCents: goods + deliveryCents,
            deliveryCents,
            status: plan.status,
            paymentMethod: plan.pay,
            channel: 'Store',
            commerceMode: 'retail',
            address: {
              line: 'House 12, Road 4',
              area: who.area,
              pincode: '1205',
            },
            placedAt,
            ...life,
          })
          .returning({ id: schema.orders.id });
        await tx.insert(schema.orderItems).values(
          lines.map((l) => ({
            orderId: order.id,
            productId: l.p.id,
            name: l.p.item.name,
            qty: l.qty,
            units: l.qty,
            unitPriceCents: cents(l.p.item.price),
          })),
        );
        built.push({
          shopId: retail.id,
          ...who,
          totalCents: goods + deliveryCents,
          placedAt,
        });
      }

      console.log('Creating quote requests…');
      type QuoteSeed = {
        buyer: keyof typeof BUYERS;
        item: string;
        qty: number;
        kind?: 'bulk' | 'sample';
        status: 'requested' | 'quoted' | 'accepted' | 'declined' | 'cancelled';
        age: number;
        unit?: number;
        expires?: number;
        used?: true;
        ask: string;
        thread?: ['buyer' | 'supplier', string, number][];
      };
      const QUOTES: QuoteSeed[] = [
        {
          buyer: 'rahim',
          item: "Men's Cotton Panjabi",
          qty: 400,
          status: 'requested',
          age: 30 * HOUR,
          ask: 'We need 400 panjabis in white and sky blue for Eid stock. What is your best price with delivery to Chattogram?',
        },
        {
          buyer: 'nadia',
          item: 'Jamdani-Pattern Cotton Saree',
          qty: 30,
          status: 'requested',
          age: 20 * HOUR,
          ask: 'Can you do 30 sarees in mixed colours? Wedding season order for our boutique.',
        },
        {
          buyer: 'nadia',
          item: "Women's Printed Three-Piece",
          qty: 2,
          kind: 'sample',
          status: 'requested',
          age: 5 * HOUR,
          ask: 'Could we get 2 samples first to check fabric quality before a bulk order?',
        },
        {
          buyer: 'rahim',
          item: "Kids' Cotton T-Shirt",
          qty: 800,
          status: 'quoted',
          age: 2 * DAY,
          unit: 200,
          expires: 5 * DAY,
          ask: 'Looking for 800 kids tees, assorted prints, sizes 4-10.',
          thread: [
            [
              'supplier',
              'We can do ৳200 per piece for 800, packed in dozens. Ready in 6 days.',
              2 * DAY - 4 * HOUR,
            ],
          ],
        },
        {
          buyer: 'nadia',
          item: 'Embroidered Winter Shawl',
          qty: 120,
          status: 'accepted',
          age: 3 * DAY,
          unit: 1090,
          expires: 4 * DAY,
          ask: 'Need 120 shawls for winter. Can you match ৳1,100?',
          thread: [
            [
              'supplier',
              'We can do ৳1,090 if you take 120. Valid for a week.',
              3 * DAY - 2 * HOUR,
            ],
            [
              'buyer',
              'Deal, accepting now. Will check out this week.',
              2 * DAY,
            ],
          ],
        },
        {
          buyer: 'rahim',
          item: "Men's Cotton Panjabi",
          qty: 120,
          status: 'accepted',
          age: 6 * DAY,
          unit: 880,
          expires: 1 * DAY,
          used: true,
          ask: 'Repeat order: 120 panjabis plus lungis. Same price as last time?',
          thread: [
            [
              'supplier',
              'Yes - ৳880 per panjabi for 120 pieces.',
              6 * DAY - 1 * HOUR,
            ],
            ['buyer', 'Accepted, placing the order.', 5 * DAY],
          ],
        },
        {
          buyer: 'rahim',
          item: 'Hand-Woven Gamcha (Set of 3)',
          qty: 2000,
          status: 'declined',
          age: 10 * DAY,
          ask: 'Can you do 2000 sets at ৳150?',
          thread: [
            [
              'supplier',
              'Sorry, ৳150 is below our cost. Our best for 2000 is ৳175.',
              10 * DAY - 6 * HOUR,
            ],
          ],
        },
        {
          buyer: 'nadia',
          item: 'Cotton Check Lungi (Pack of 2)',
          qty: 300,
          status: 'quoted',
          age: 12 * DAY,
          unit: 370,
          expires: -2 * DAY,
          ask: '300 packs of lungi for a corporate gift order?',
          thread: [
            [
              'supplier',
              '৳370 per pack for 300. Offer valid 10 days.',
              12 * DAY - 30 * HOUR,
            ],
          ],
        },
      ];
      let wonQuoteId: string | null = null;
      for (const q of QUOTES) {
        const p = supplierProducts.get(q.item)!;
        const createdAt = ago(q.age);
        const [row] = await tx
          .insert(schema.tradeQuotes)
          .values({
            buyerId: buyers[q.buyer].id,
            shopId: supplier.id,
            productId: p.id,
            kind: q.kind ?? 'bulk',
            qty: q.qty,
            message: q.ask,
            status: q.status,
            unitPriceCents: q.unit != null ? cents(q.unit) : null,
            expiresAt: q.expires != null ? ahead(q.expires) : null,
            usedAt: q.used ? ago(5 * DAY - HOUR) : null,
            createdAt,
            updatedAt: q.thread?.length ? ago(q.thread.at(-1)![2]) : createdAt,
          })
          .returning({ id: schema.tradeQuotes.id });
        if (q.used) wonQuoteId = row.id;
        for (const [sender, text, at] of q.thread ?? [])
          await tx
            .insert(schema.tradeMessages)
            .values({ quoteId: row.id, sender, text, createdAt: ago(at) });
      }

      console.log('Creating wholesale and reseller orders…');
      const tierPrice = (it: Item, qty: number) =>
        [...(it.tiers ?? [])].reverse().find(([min]) => qty >= min)?.[1] ??
        it.price;
      type Supplied = { placedAt: Date; insert: () => Promise<void> };
      const supplied: Supplied[] = [];
      for (const plan of WHOLESALE_PLANS) {
        const b = BUYERS[plan.buyer];
        const placedAt = ago(plan.age);
        supplied.push({
          placedAt,
          insert: async () => {
            const lines = plan.lines.map(([n, qty]) => {
              const p = supplierProducts.get(n)!;
              const unit =
                plan.quote && n === "Men's Cotton Panjabi"
                  ? 880
                  : tierPrice(p.item, qty);
              return { p, qty, unitCents: cents(unit) };
            });
            const deliveryCents = cents(450);
            const goods = lines.reduce((s, l) => s + l.unitCents * l.qty, 0);
            const life = lifecycle(plan.status, placedAt, plan.pay);
            const email = b.email;
            const phone = fakePhone();
            const [order] = await tx
              .insert(schema.orders)
              .values({
                reference: nextRef(supplier.id),
                shopId: supplier.id,
                userId: buyers[plan.buyer].id,
                customerName: `${b.name} (${b.person})`,
                email,
                phone,
                qty: lines.reduce((s, l) => s + l.qty, 0),
                totalCents: goods + deliveryCents,
                deliveryCents,
                status: plan.status,
                paymentMethod: plan.pay,
                channel: 'Store',
                commerceMode: 'wholesale',
                tradeQuoteId: plan.quote ? wonQuoteId : null,
                address: {
                  line: 'Shop 14, Reazuddin Bazar',
                  area: b.area,
                  pincode: '4000',
                },
                placedAt,
                ...life,
              })
              .returning({ id: schema.orders.id });
            await tx.insert(schema.orderItems).values(
              lines.map((l) => ({
                orderId: order.id,
                productId: l.p.id,
                name: l.p.item.name,
                qty: l.qty,
                units: l.qty,
                unitPriceCents: l.unitCents,
              })),
            );
            if (plan.dispute)
              await tx.insert(schema.tradeDisputes).values({
                orderId: order.id,
                buyerId: buyers[plan.buyer].id,
                shopId: supplier.id,
                reason: plan.dispute,
                status: 'open',
                createdAt: ago(plan.age - 3 * DAY),
              });
            built.push({
              shopId: supplier.id,
              name: `${b.name} (${b.person})`,
              email,
              phone,
              area: b.area,
              totalCents: goods + deliveryCents,
              placedAt,
            });
          },
        });
      }
      for (const plan of RESELL_PLANS) {
        const placedAt = ago(plan.age);
        supplied.push({
          placedAt,
          insert: async () => {
            const who = person(plan.person);
            const [[name, qty]] = plan.lines;
            const extra = plan.lines.slice(1);
            const listing = listingByItem.get(name)!;
            const p = supplierProducts.get(name)!;
            // Real checkout: lines at supply price, the reseller's margin on top.
            let marginCents = (listing.sellCents - listing.supplyCents) * qty;
            const lines = [{ p, qty, unitCents: listing.supplyCents }];
            for (const [n, q] of extra) {
              const l = listingByItem.get(n)!;
              marginCents += (l.sellCents - l.supplyCents) * q;
              lines.push({
                p: supplierProducts.get(n)!,
                qty: q,
                unitCents: l.supplyCents,
              });
            }
            const deliveryCents = who.area.includes('Dhaka')
              ? cents(60)
              : cents(120);
            const goods = lines.reduce((s, l) => s + l.unitCents * l.qty, 0);
            const life = lifecycle(plan.status, placedAt, plan.pay);
            const [order] = await tx
              .insert(schema.orders)
              .values({
                reference: nextRef(supplier.id),
                shopId: supplier.id,
                customerName: who.name,
                email: who.email,
                phone: who.phone,
                qty: lines.reduce((s, l) => s + l.qty, 0),
                totalCents: goods + deliveryCents + marginCents,
                deliveryCents,
                status: plan.status,
                paymentMethod: plan.pay,
                channel: 'Store',
                commerceMode: 'reseller',
                buyerShop: {
                  name: reseller.name,
                  handle: reseller.handle,
                  supportPhone: reseller.supportPhone ?? undefined,
                },
                resellerShopId: reseller.id,
                resellerListingId: listing.id,
                resellerMarginCents: marginCents,
                address: {
                  line: 'Flat 3B, Lake View',
                  area: who.area,
                  pincode: '1207',
                },
                placedAt,
                ...life,
              })
              .returning({ id: schema.orders.id });
            await tx.insert(schema.orderItems).values(
              lines.map((l) => ({
                orderId: order.id,
                productId: l.p.id,
                name: l.p.item.name,
                qty: l.qty,
                units: l.qty,
                unitPriceCents: l.unitCents,
              })),
            );
            built.push({
              shopId: supplier.id,
              ...who,
              totalCents: goods + deliveryCents + marginCents,
              placedAt,
            });
          },
        });
      }
      // One reference sequence for the supplier, oldest order first.
      for (const s of supplied.sort(
        (a, b) => a.placedAt.getTime() - b.placedAt.getTime(),
      ))
        await s.insert();

      console.log('Building customer records…');
      const byKey = new Map<string, Built[]>();
      for (const b of built)
        byKey.set(`${b.shopId}|${b.email}`, [
          ...(byKey.get(`${b.shopId}|${b.email}`) ?? []),
          b,
        ]);
      for (const list of byKey.values()) {
        const first = list.reduce((a, b) => (a.placedAt < b.placedAt ? a : b));
        const last = list.reduce((a, b) => (a.placedAt > b.placedAt ? a : b));
        const spent = list.reduce((s, b) => s + b.totalCents, 0);
        const [customer] = await tx
          .insert(schema.customers)
          .values({
            shopId: first.shopId,
            name: first.name,
            email: first.email,
            phone: first.phone,
            city: first.area,
            ordersCount: list.length,
            spentCents: spent,
            firstOrderAt: first.placedAt,
            lastOrderAt: last.placedAt,
            segment:
              spent >= cents(100_000) || list.length >= 3
                ? 'VIP'
                : list.length >= 2
                  ? 'Repeat'
                  : 'New',
          })
          .returning({ id: schema.customers.id });
        await tx
          .update(schema.orders)
          .set({ customerId: customer.id })
          .where(
            and(
              eq(schema.orders.shopId, first.shopId),
              eq(schema.orders.email, first.email),
            ),
          );
      }

      console.log(
        `\n✅ Demo set ready: ${built.length} orders, ${QUOTES.length} quotes, ${RESELL.length} reseller listings.\n`,
      );
      console.log('Storefronts:');
      for (const [type, handle] of Object.entries(HANDLES))
        console.log(`  ${type.padEnd(9)} https://hoomri.com/shop/${handle}`);
      console.log('\nSeller logins (new random passwords - shown once):');
      if (dryRun) throw new DryRun();
      for (const [email, pass] of Object.entries(passwords))
        console.log(`  ${email.padEnd(32)} ${pass}`);
    });
  } catch (e) {
    if (!(e instanceof DryRun)) throw e;
    console.log(
      '  (dry run - every insert succeeded, then rolled back; nothing was saved)',
    );
  } finally {
    await client.end({ timeout: 5 });
  }
}

class DryRun extends Error {}

seed().catch((err) => {
  console.error('Demo seed failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
