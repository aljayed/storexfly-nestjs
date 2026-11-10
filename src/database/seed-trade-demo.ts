import 'dotenv/config';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { and, eq, inArray, like, notLike, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { COMMISSION_BPS } from '../common/constants/billing';
import { BRAND_SWATCHES } from '../common/constants/brand-swatches';
import type { CommercePolicy } from '../common/commerce/commerce';
import { handleize } from '../common/utils/slug.util';
import { generatePublicId } from '../common/utils/public-id.util';
import * as schema from './schema';
import type { OrderStatus, ProductTag } from './schema/enums';

/**
 * B2B and reseller demo content for one real shop (Humri), so its wholesale
 * and reseller consoles have something to show.
 *
 * Reselling always involves two shops with different owners, so one demo
 * partner shop (Krishi Bazar BD) stands on the other side of every trade:
 *  - Humri supplies: agro products with tier prices, bulk orders from demo
 *    business buyers, quote requests, a trade case - and orders from the
 *    partner's customers, which Humri ships.
 *  - Humri resells: listings of the partner's products, and the orders its
 *    own customers placed for them.
 *
 *   node dist/src/database/seed-trade-demo.js --force             # (re)create
 *   node dist/src/database/seed-trade-demo.js --force --remove    # take it out
 *   ... --dry-run   # do all of it inside the transaction, then roll back
 *
 * The target shop is real, so this is careful about what it touches:
 *  - Only rows it made are removed: `demo-` shop handles, `@example.com`
 *    accounts and orders, and Humri products named in HUMRI_ITEMS. Humri's
 *    own products, orders and settings are never changed.
 *  - Cleanup refuses to delete any order or quote made by a real account.
 *  - Every demo order touching Humri is cash on delivery: settlements never
 *    pay COD out of platform funds, so no payout to Humri's bank appears.
 *  - Humri's sales credit is metered on its orders. The seed adds the demo
 *    orders' value to the credit grant and cleanup takes the same amount
 *    back (order totals never change), so Humri's real balance is unchanged.
 *  - Order references continue Humri's own sequence (#1001 + count), and
 *    cleanup refuses to leave a gap that would make the next real order
 *    reuse an existing reference.
 *  - Contacts are unreachable (example.com, the unassigned 010 prefix) and
 *    the partner owner's password is random per run.
 */

const TARGET_HANDLE = 'humri';
const DOMAIN = 'example.com';
/** Every demo shop handle this script has ever created - all are cleared. */
const DEMO_HANDLES = [
  'demo-krishi-bazar',
  'demo-dhaka-daily',
  'demo-shapla-textiles',
  'demo-trendy-corner',
];
const PARTNER_HANDLE = 'demo-krishi-bazar';
const PARTNER_OWNER = {
  email: `demo.partner@${DOMAIN}`,
  name: 'Sohel Rana (Demo)',
};
const BUYERS = {
  rahim: {
    email: `demo.rahim.poultry@${DOMAIN}`,
    name: 'Rahim Poultry Farm',
    person: 'Rahim Uddin',
    area: 'Gazipur',
  },
  dairy: {
    email: `demo.greenvalley.dairy@${DOMAIN}`,
    name: 'Green Valley Dairy',
    person: 'Nadia Islam',
    area: 'Bogura',
  },
  fish: {
    email: `demo.meghna.hatchery@${DOMAIN}`,
    name: 'Meghna Fish Hatchery',
    person: 'Jahid Hasan',
    area: 'Mymensingh',
  },
} as const;
/** Accounts of earlier demo sets, cleared too. */
const LEGACY_EMAILS = [
  'demo.retail@example.com',
  'demo.supplier@example.com',
  'demo.reseller@example.com',
  'demo.rahim.traders@example.com',
  'demo.nadia.boutique@example.com',
];
const DEMO_EMAILS = [
  PARTNER_OWNER.email,
  ...Object.values(BUYERS).map((b) => b.email),
  ...LEGACY_EMAILS,
];

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms);
const ahead = (ms: number) => new Date(NOW + ms);
const cents = (taka: number) => Math.round(taka * 100);
let phoneSeq = 0;
/** 010 is not an assigned Bangladeshi operator prefix: well-formed, unreachable. */
const fakePhone = () => `010000${String(++phoneSeq).padStart(5, '0')}`;

type Tx = Parameters<
  Parameters<ReturnType<typeof drizzle<typeof schema>>['transaction']>[0]
>[0];

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
  reseller?: number;
  moq?: number;
  tiers?: [number, number][];
}

/** Added to Humri - and identified by these names when cleared. */
const HUMRI_ITEMS: Item[] = [
  {
    name: 'Layer Poultry Feed 50kg',
    cat: 'Poultry feed',
    price: 2950,
    unit: '50 kg bag',
    stock: 640,
    emoji: '🐔',
    tone: '#fdf3d6',
    tag: 'Bestseller',
    rating: 4.8,
    reviews: 96,
    blurb:
      'Balanced layer mash with 17% protein, calcium and vitamin premix for steady laying.',
    reseller: 2450,
    moq: 10,
    tiers: [
      [10, 2650],
      [50, 2520],
      [200, 2400],
    ],
  },
  {
    name: 'Cattle Fattening Feed 25kg',
    cat: 'Cattle feed',
    price: 1450,
    unit: '25 kg bag',
    stock: 900,
    emoji: '🐄',
    tone: '#e2f1e8',
    rating: 4.7,
    reviews: 58,
    blurb:
      'High-energy pellet for beef fattening, with bypass protein and rumen buffers.',
    reseller: 1180,
    moq: 20,
    tiers: [
      [20, 1260],
      [100, 1190],
    ],
  },
  {
    name: 'Floating Fish Feed 20kg',
    cat: 'Fish feed',
    price: 1650,
    unit: '20 kg bag',
    stock: 420,
    emoji: '🐟',
    tone: '#e9eefc',
    rating: 4.6,
    reviews: 41,
    blurb:
      'Extruded floating pellet, 28% protein, for tilapia and pangas ponds.',
    reseller: 1350,
    moq: 20,
    tiers: [
      [20, 1440],
      [100, 1370],
    ],
  },
  {
    name: 'Vitamin & Mineral Premix 1kg',
    cat: 'Supplements',
    price: 480,
    unit: '1 kg pack',
    stock: 1500,
    emoji: '💊',
    tone: '#ebe6f8',
    tag: 'New',
    rating: 4.7,
    reviews: 23,
    blurb:
      'Mix 2.5 kg per tonne of feed. Covers A, D3, E, B-complex and trace minerals.',
    reseller: 360,
    moq: 50,
    tiers: [
      [50, 395],
      [300, 365],
    ],
  },
  {
    name: 'Liquid Calcium Supplement 1L',
    cat: 'Supplements',
    price: 350,
    unit: '1 litre',
    stock: 6,
    emoji: '🧴',
    tone: '#f8e3dc',
    rating: 4.5,
    reviews: 19,
    blurb:
      'Calcium, phosphorus and vitamin D3 for dairy cows after calving and for layers.',
    reseller: 260,
    moq: 48,
    tiers: [[48, 285]],
  },
  {
    name: 'Poultry Drinker 5L',
    cat: 'Farm equipment',
    price: 220,
    unit: 'piece',
    stock: 2000,
    emoji: '🚰',
    tone: '#e9eefc',
    rating: 4.4,
    reviews: 31,
    blurb:
      'Food-grade plastic drinker with twist-lock base. Wholesale cartons of 100.',
    moq: 100,
    tiers: [
      [100, 150],
      [500, 135],
    ],
  },
];

/** The partner's catalogue - what Humri resells. */
const PARTNER_ITEMS: Item[] = [
  {
    name: 'Hybrid Maize Seed 1kg',
    cat: 'Seeds',
    price: 650,
    unit: '1 kg pack',
    stock: 800,
    emoji: '🌽',
    tone: '#fdf3d6',
    tag: 'Bestseller',
    rating: 4.7,
    reviews: 77,
    blurb: 'High-yield hybrid for rabi season. 110 to 120 days to harvest.',
    reseller: 480,
  },
  {
    name: 'Organic Vermicompost 10kg',
    cat: 'Fertiliser',
    price: 420,
    unit: '10 kg bag',
    stock: 1200,
    emoji: '🪱',
    tone: '#efe4dc',
    rating: 4.8,
    reviews: 54,
    blurb:
      'Earthworm compost from Jashore. Improves soil structure and water holding.',
    reseller: 300,
  },
  {
    name: 'Knapsack Sprayer 16L',
    cat: 'Farm equipment',
    price: 2100,
    unit: 'piece',
    stock: 90,
    emoji: '🧯',
    tone: '#e2f1e8',
    rating: 4.5,
    reviews: 28,
    blurb: 'Manual pressure sprayer with brass lance and three nozzles.',
    reseller: 1650,
  },
  {
    name: 'Drip Irrigation Starter Kit',
    cat: 'Farm equipment',
    price: 3800,
    unit: 'kit for 1 bigha',
    stock: 0,
    emoji: '💧',
    tone: '#e9eefc',
    rating: 4.6,
    reviews: 12,
    blurb:
      'Mainline, drippers and filter for one bigha of vegetables. Restocking soon.',
    reseller: 3050,
  },
  {
    name: 'Mineral Lick Block 5kg',
    cat: 'Supplements',
    price: 380,
    unit: '5 kg block',
    stock: 400,
    emoji: '🧂',
    tone: '#f8e3dc',
    rating: 4.4,
    reviews: 20,
    blurb: 'Salt and trace-mineral block for cattle and goats.',
    reseller: 340,
  },
  {
    name: 'Vegetable Seed Combo Pack',
    cat: 'Seeds',
    price: 250,
    unit: '6 varieties',
    stock: 600,
    emoji: '🥬',
    tone: '#e2f1e8',
    rating: 4.6,
    reviews: 45,
    blurb:
      'Spinach, red amaranth, okra, bottle gourd, tomato and chilli seeds.',
    reseller: 170,
  },
];

/** The partner reselling Humri's products, at its own prices. */
const PARTNER_RESELLS: { item: string; price: number }[] = [
  { item: 'Layer Poultry Feed 50kg', price: 2890 },
  { item: 'Cattle Fattening Feed 25kg', price: 1390 },
  { item: 'Floating Fish Feed 20kg', price: 1590 },
  { item: 'Vitamin & Mineral Premix 1kg', price: 449 },
];
/** Humri reselling the partner's products: live, thin margin, out of stock, paused. */
const HUMRI_RESELLS: { item: string; price: number; active?: boolean }[] = [
  { item: 'Hybrid Maize Seed 1kg', price: 599 },
  { item: 'Organic Vermicompost 10kg', price: 399 },
  { item: 'Knapsack Sprayer 16L', price: 1990 },
  { item: 'Drip Irrigation Starter Kit', price: 3590 },
  { item: 'Mineral Lick Block 5kg', price: 349 },
  { item: 'Vegetable Seed Combo Pack', price: 229, active: false },
];

const PEOPLE = [
  ['Abdul Karim', 'Savar, Dhaka'],
  ['Rokeya Begum', 'Trishal, Mymensingh'],
  ['Mizanur Rahman', 'Sherpur, Bogura'],
  ['Shahida Khatun', 'Kaliganj, Gazipur'],
  ['Habibur Rahman', 'Chandina, Cumilla'],
  ['Monira Akter', 'Pirganj, Rangpur'],
  ['Jamal Uddin', 'Sreepur, Gazipur'],
  ['Parvin Sultana', 'Ishwardi, Pabna'],
  ['Kamrul Hasan', 'Fulbaria, Mymensingh'],
  ['Salma Khatun', 'Sadar, Jashore'],
  ['Delwar Hossain', 'Tangail Sadar'],
  ['Nasrin Jahan', 'Keraniganj, Dhaka'],
] as const;

interface Plan {
  status: OrderStatus;
  /** Age, kept inside the platform's order deadlines (order-deadlines.ts). */
  age: number;
  lines: [string, number][];
}
const WHOLESALE_PLANS: (Plan & {
  buyer: keyof typeof BUYERS;
  quote?: true;
  dispute?: string;
})[] = [
  {
    status: 'New',
    age: 5 * HOUR,
    buyer: 'dairy',
    lines: [['Cattle Fattening Feed 25kg', 60]],
  },
  {
    status: 'Confirmed',
    age: 1 * DAY,
    buyer: 'rahim',
    lines: [['Layer Poultry Feed 50kg', 120]],
    quote: true,
  },
  {
    status: 'Packed',
    age: 2 * DAY,
    buyer: 'fish',
    lines: [['Floating Fish Feed 20kg', 100]],
  },
  {
    status: 'Shipped',
    age: 4 * DAY,
    buyer: 'rahim',
    lines: [
      ['Poultry Drinker 5L', 500],
      ['Vitamin & Mineral Premix 1kg', 100],
    ],
  },
  {
    status: 'Delivered',
    age: 8 * DAY,
    buyer: 'dairy',
    lines: [['Cattle Fattening Feed 25kg', 100]],
    dispute:
      '7 of the 100 bags arrived torn and wet from rain during unloading. Photos are in the chat - please replace or credit them.',
  },
  {
    status: 'Delivered',
    age: 15 * DAY,
    buyer: 'fish',
    lines: [['Floating Fish Feed 20kg', 200]],
  },
  {
    status: 'Delivered',
    age: 24 * DAY,
    buyer: 'rahim',
    lines: [['Layer Poultry Feed 50kg', 50]],
  },
];
/** The partner's customers buying Humri's products; Humri ships. */
const VIA_PARTNER: (Plan & { person: number })[] = [
  {
    status: 'New',
    age: 4 * HOUR,
    person: 0,
    lines: [['Layer Poultry Feed 50kg', 2]],
  },
  {
    status: 'Confirmed',
    age: 1 * DAY,
    person: 1,
    lines: [['Floating Fish Feed 20kg', 3]],
  },
  {
    status: 'HandedOver',
    age: 3 * DAY,
    person: 2,
    lines: [['Cattle Fattening Feed 25kg', 4]],
  },
  {
    status: 'Delivered',
    age: 6 * DAY,
    person: 3,
    lines: [['Vitamin & Mineral Premix 1kg', 5]],
  },
  {
    status: 'Delivered',
    age: 11 * DAY,
    person: 4,
    lines: [['Layer Poultry Feed 50kg', 3]],
  },
  {
    status: 'Delivered',
    age: 20 * DAY,
    person: 5,
    lines: [['Cattle Fattening Feed 25kg', 2]],
  },
];
/** Humri's own customers buying the partner's products; the partner ships. */
const HUMRI_RESOLD: (Plan & { person: number })[] = [
  {
    status: 'New',
    age: 2 * HOUR,
    person: 6,
    lines: [['Hybrid Maize Seed 1kg', 4]],
  },
  {
    status: 'Confirmed',
    age: 20 * HOUR,
    person: 7,
    lines: [['Knapsack Sprayer 16L', 1]],
  },
  {
    status: 'Packed',
    age: 2 * DAY,
    person: 8,
    lines: [['Organic Vermicompost 10kg', 6]],
  },
  {
    status: 'Shipped',
    age: 3 * DAY,
    person: 9,
    lines: [['Hybrid Maize Seed 1kg', 10]],
  },
  {
    status: 'Delivered',
    age: 5 * DAY,
    person: 10,
    lines: [['Knapsack Sprayer 16L', 2]],
  },
  {
    status: 'Delivered',
    age: 9 * DAY,
    person: 11,
    lines: [['Organic Vermicompost 10kg', 10]],
  },
  {
    status: 'Delivered',
    age: 13 * DAY,
    person: 0,
    lines: [['Hybrid Maize Seed 1kg', 5]],
  },
  {
    status: 'Cancelled',
    age: 14 * DAY,
    person: 3,
    lines: [['Mineral Lick Block 5kg', 4]],
  },
  {
    status: 'Delivered',
    age: 19 * DAY,
    person: 2,
    lines: [['Organic Vermicompost 10kg', 8]],
  },
];

/* ── Cleanup ────────────────────────────────────────────────────── */

const NONE = ['00000000-0000-0000-0000-000000000000'];
const ids = (xs: { id: string }[]) => (xs.length ? xs.map((x) => x.id) : NONE);
const refNumber = (r: string) => Number(r.replace(/\D/g, '')) || 0;

async function clear(
  tx: Tx,
  target: typeof schema.shops.$inferSelect,
): Promise<void> {
  const S = ids(
    await tx
      .select({ id: schema.shops.id })
      .from(schema.shops)
      .where(inArray(schema.shops.handle, DEMO_HANDLES)),
  );
  const userRows = await tx
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(inArray(schema.users.email, DEMO_EMAILS));
  const U = ids(userRows);
  const P = ids(
    await tx
      .select({ id: schema.products.id })
      .from(schema.products)
      .where(
        or(
          inArray(schema.products.shopId, S),
          and(
            eq(schema.products.shopId, target.id),
            inArray(
              schema.products.name,
              HUMRI_ITEMS.map((i) => i.name),
            ),
          ),
        ),
      ),
  );
  const L = ids(
    await tx
      .select({ id: schema.resellerListings.id })
      .from(schema.resellerListings)
      .where(
        or(
          inArray(schema.resellerListings.shopId, S),
          inArray(schema.resellerListings.productId, P),
        ),
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
  const Q = ids(quotes);
  const demoOnTarget = and(
    eq(schema.orders.shopId, target.id),
    like(schema.orders.email, `%@${DOMAIN}`),
  );
  const touching = or(
    inArray(schema.orders.shopId, S),
    inArray(schema.orders.resellerShopId, S),
    inArray(schema.orders.resellerListingId, L),
    inArray(schema.orders.tradeQuoteId, Q),
    inArray(schema.orders.userId, U),
    demoOnTarget,
  );

  // Never delete what a real person did.
  const foreign = await tx
    .select({ reference: schema.orders.reference })
    .from(schema.orders)
    .where(and(touching, notLike(schema.orders.email, `%@${DOMAIN}`)));
  const foreignQuotes = quotes.filter(
    (q) => !userRows.some((u) => u.id === q.buyerId),
  );
  if (foreign.length || foreignQuotes.length) {
    throw new Error(
      `Refusing to clear the demo set: ${foreign.length} order(s) and ${foreignQuotes.length} quote(s) involve real accounts ` +
        `(${foreign.map((o) => o.reference).join(', ')}). Handle them by hand first.`,
    );
  }

  // Take back exactly the credit the seed added: the value of the demo orders
  // on the target shop (totals never change, only statuses).
  const [{ value }] = await tx
    .select({
      value: sql<string>`coalesce(sum(${schema.orders.totalCents}), 0)`,
    })
    .from(schema.orders)
    .where(demoOnTarget);
  const offset = Number(value);
  if (offset) {
    await tx
      .update(schema.subscriptions)
      .set({
        creditGrantedCents: sql`${schema.subscriptions.creditGrantedCents} - ${offset}`,
      })
      .where(eq(schema.subscriptions.shopId, target.id));
  }

  const O = ids(
    await tx
      .select({ id: schema.orders.id })
      .from(schema.orders)
      .where(touching),
  );
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
  await tx
    .delete(schema.customers)
    .where(
      and(
        eq(schema.customers.shopId, target.id),
        like(schema.customers.email, `%@${DOMAIN}`),
      ),
    );
  await tx
    .delete(schema.products)
    .where(
      and(
        eq(schema.products.shopId, target.id),
        inArray(schema.products.id, P),
      ),
    );
  await tx.delete(schema.shops).where(inArray(schema.shops.id, S));
  await tx.delete(schema.users).where(inArray(schema.users.id, U));

  // The next real order is numbered #1001 + count. If real orders arrived
  // after the demo ones, removing the demo would make that number collide.
  const left = await tx
    .select({ reference: schema.orders.reference })
    .from(schema.orders)
    .where(eq(schema.orders.shopId, target.id));
  const highest = Math.max(1000, ...left.map((o) => refNumber(o.reference)));
  if (highest > 1000 + left.length) {
    throw new Error(
      `Refusing: ${target.name} has real orders numbered up to #${highest}, but only ${left.length} would remain, so its next order ` +
        `(#${1001 + left.length}) would reuse a reference. Leave the demo orders in place.`,
    );
  }
  console.log(
    `  Cleared ${O === NONE ? 0 : O.length} demo order(s); credit adjustment of ৳${offset / 100} reversed.`,
  );
}

/* ── Seeding ────────────────────────────────────────────────────── */

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

/** Timestamps an order at `status` would carry. Cash on delivery throughout. */
function lifecycle(status: OrderStatus, placedAt: Date) {
  const at = (h: number) =>
    new Date(Math.min(placedAt.getTime() + h * HOUR, NOW - 10 * 60_000));
  const reached = (s: OrderStatus[]) => s.includes(status);
  return {
    paymentMethod: 'cod',
    pay: status === 'Delivered' ? ('Paid' as const) : ('Due' as const),
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
  let partnerPassword = '';

  try {
    await db.transaction(async (tx) => {
      const target = await tx.query.shops.findFirst({
        where: eq(schema.shops.handle, TARGET_HANDLE),
      });
      if (!target) throw new Error(`No shop with handle "${TARGET_HANDLE}".`);
      const sub = await tx.query.subscriptions.findFirst({
        where: eq(schema.subscriptions.shopId, target.id),
      });
      if (!sub)
        throw new Error(
          `${target.name} has no billing record; refusing to add metered orders.`,
        );
      if (!target.paymentMethods.includes('card'))
        throw new Error(
          `${target.name} accepts no online payment, so its products cannot be resold.`,
        );

      console.log(`Clearing earlier demo content (target: ${target.name})…`);
      await clear(tx, target);
      if (remove) return;

      console.log('Creating the partner shop and demo buyers…');
      partnerPassword = randomBytes(12).toString('base64url');
      const mkUser = async (
        u: { email: string; name: string },
        pass?: string,
      ) =>
        (
          await tx
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
            .returning()
        )[0];
      const partnerOwner = await mkUser(PARTNER_OWNER, partnerPassword);
      const buyers = {} as Record<
        keyof typeof BUYERS,
        typeof schema.users.$inferSelect
      >;
      for (const k of Object.keys(BUYERS) as (keyof typeof BUYERS)[])
        buyers[k] = await mkUser({
          email: BUYERS[k].email,
          name: BUYERS[k].person,
        });
      const sw = BRAND_SWATCHES.green;
      const [partner] = await tx
        .insert(schema.shops)
        .values({
          name: 'Krishi Bazar BD',
          handle: PARTNER_HANDLE,
          tagline:
            'Seeds, inputs and farm tools for growers across Bangladesh.',
          cat: target.cat,
          brandId: 'green',
          brand: sw.c,
          brandSoft: sw.soft,
          ownerId: partnerOwner.id,
          businessType: 'reseller',
          paymentMethods: ['card', 'cod'],
          supportPhone: fakePhone(),
          supportEmail: `support.${PARTNER_HANDLE}@${DOMAIN}`,
          kycStatus: 'verified',
        })
        .returning();
      await tx.insert(schema.subscriptions).values({
        shopId: partner.id,
        ownerId: partnerOwner.id,
        status: 'active',
        billingMode: 'credits',
        currency: 'BDT',
        commissionBps: COMMISSION_BPS,
        creditGrantedCents: cents(500_000),
        meterStartAt: ago(40 * DAY),
        startedAt: ago(40 * DAY),
        nextBillingAt: ahead(20 * DAY),
      });

      console.log('Adding catalogues…');
      const humriProducts = await createProducts(tx, target.id, HUMRI_ITEMS);
      const partnerProducts = await createProducts(
        tx,
        partner.id,
        PARTNER_ITEMS,
      );
      for (const [name, author, rating, body] of [
        [
          'Layer Poultry Feed 50kg',
          'Abdul Karim',
          5,
          'Laying went up within two weeks of switching. Bags arrive sealed and dry.',
        ],
        [
          'Cattle Fattening Feed 25kg',
          'Mizanur Rahman',
          4,
          'Good weight gain before Eid. Delivery to Bogura took three days.',
        ],
        [
          'Floating Fish Feed 20kg',
          'Rokeya Begum',
          5,
          'Pellets really float, much less waste in the pond.',
        ],
      ] as const) {
        await tx.insert(schema.reviews).values({
          productId: humriProducts.get(name)!.id,
          author,
          rating,
          body,
          verified: true,
          createdAt: ago(6 * DAY),
        });
      }

      console.log('Creating reseller listings both ways…');
      const listing = new Map<
        string,
        {
          id: string;
          shop: 'humri' | 'partner';
          sellCents: number;
          supplyCents: number;
        }
      >();
      for (const r of PARTNER_RESELLS) {
        const p = humriProducts.get(r.item)!;
        const [row] = await tx
          .insert(schema.resellerListings)
          .values({
            shopId: partner.id,
            productId: p.id,
            sellingPriceCents: cents(r.price),
            createdAt: ago(30 * DAY),
          })
          .returning({ id: schema.resellerListings.id });
        listing.set(r.item, {
          id: row.id,
          shop: 'partner',
          sellCents: cents(r.price),
          supplyCents: cents(p.item.reseller!),
        });
      }
      for (const r of HUMRI_RESELLS) {
        const p = partnerProducts.get(r.item)!;
        const [row] = await tx
          .insert(schema.resellerListings)
          .values({
            shopId: target.id,
            productId: p.id,
            sellingPriceCents: cents(r.price),
            active: r.active ?? true,
            createdAt: ago(30 * DAY),
          })
          .returning({ id: schema.resellerListings.id });
        listing.set(r.item, {
          id: row.id,
          shop: 'humri',
          sellCents: cents(r.price),
          supplyCents: cents(p.item.reseller!),
        });
      }

      console.log('Creating quote requests…');
      type QuoteSeed = {
        buyer: keyof typeof BUYERS;
        item: string;
        qty: number;
        kind?: 'bulk' | 'sample';
        status: 'requested' | 'quoted' | 'accepted' | 'declined';
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
          item: 'Layer Poultry Feed 50kg',
          qty: 400,
          status: 'requested',
          age: 30 * HOUR,
          ask: 'We need 400 bags of layer feed every month for our 12,000-bird farm. What is your best monthly contract price?',
        },
        {
          buyer: 'fish',
          item: 'Floating Fish Feed 20kg',
          qty: 300,
          status: 'requested',
          age: 20 * HOUR,
          ask: 'Stocking season is starting. Can you supply 300 bags to Mymensingh within a week?',
        },
        {
          buyer: 'dairy',
          item: 'Liquid Calcium Supplement 1L',
          qty: 2,
          kind: 'sample',
          status: 'requested',
          age: 5 * HOUR,
          ask: 'Could we try 2 bottles on our fresh cows before ordering cartons?',
        },
        {
          buyer: 'dairy',
          item: 'Vitamin & Mineral Premix 1kg',
          qty: 500,
          status: 'quoted',
          age: 2 * DAY,
          unit: 355,
          expires: 5 * DAY,
          ask: '500 packs of premix for our feed mill - any better price than the listed tier?',
          thread: [
            [
              'supplier',
              'We can do ৳355 per pack for 500, delivered to Bogura in 4 days.',
              2 * DAY - 3 * HOUR,
            ],
          ],
        },
        {
          buyer: 'fish',
          item: 'Floating Fish Feed 20kg',
          qty: 150,
          status: 'accepted',
          age: 3 * DAY,
          unit: 1360,
          expires: 4 * DAY,
          ask: 'Can you match ৳1,350 for 150 bags?',
          thread: [
            [
              'supplier',
              '৳1,360 is our best for 150 bags, valid a week.',
              3 * DAY - 2 * HOUR,
            ],
            ['buyer', 'Accepted. We will check out this week.', 2 * DAY],
          ],
        },
        {
          buyer: 'rahim',
          item: 'Layer Poultry Feed 50kg',
          qty: 120,
          status: 'accepted',
          age: 6 * DAY,
          unit: 2480,
          expires: 1 * DAY,
          used: true,
          ask: 'Repeat order: 120 bags at last month’s price?',
          thread: [
            ['supplier', 'Yes, ৳2,480 per bag for 120.', 6 * DAY - HOUR],
            ['buyer', 'Accepted, placing the order.', 5 * DAY],
          ],
        },
        {
          buyer: 'dairy',
          item: 'Cattle Fattening Feed 25kg',
          qty: 1000,
          status: 'declined',
          age: 10 * DAY,
          ask: 'Can you do 1,000 bags at ৳1,000?',
          thread: [
            [
              'supplier',
              'Sorry, ৳1,000 is below our cost. Our best for 1,000 bags is ৳1,150.',
              10 * DAY - 5 * HOUR,
            ],
          ],
        },
        {
          buyer: 'rahim',
          item: 'Poultry Drinker 5L',
          qty: 1000,
          status: 'quoted',
          age: 12 * DAY,
          unit: 128,
          expires: -2 * DAY,
          ask: '1,000 drinkers for a new shed?',
          thread: [
            [
              'supplier',
              '৳128 each for 1,000. Offer valid 10 days.',
              12 * DAY - 28 * HOUR,
            ],
          ],
        },
      ];
      let wonQuoteId: string | null = null;
      for (const q of QUOTES) {
        const p = humriProducts.get(q.item)!;
        const createdAt = ago(q.age);
        const [row] = await tx
          .insert(schema.tradeQuotes)
          .values({
            buyerId: buyers[q.buyer].id,
            shopId: target.id,
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

      console.log('Creating orders…');
      // Continue each shop's own reference sequence.
      const [{ n: existing }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.orders)
        .where(eq(schema.orders.shopId, target.id));
      const refs = new Map<string, number>([
        [target.id, 1000 + existing],
        [partner.id, 1000],
      ]);
      const nextRef = (shopId: string) => {
        const n = refs.get(shopId)! + 1;
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
      const tier = (it: Item, qty: number) =>
        [...(it.tiers ?? [])].reverse().find(([min]) => qty >= min)?.[1] ??
        it.price;
      const built: Built[] = [];
      const jobs: { placedAt: Date; run: () => Promise<void> }[] = [];

      const insertOrder = async (o: {
        shopId: string;
        plan: Plan;
        who: { name: string; email: string; phone: string; area: string };
        userId?: string;
        lines: {
          productId: string;
          name: string;
          qty: number;
          unitCents: number;
        }[];
        deliveryCents: number;
        marginCents?: number;
        mode: 'wholesale' | 'reseller';
        resellerShop?: typeof partner;
        listingId?: string;
        quoteId?: string | null;
        dispute?: { buyerId: string; reason: string };
      }) => {
        const placedAt = ago(o.plan.age);
        const goods = o.lines.reduce((s, l) => s + l.unitCents * l.qty, 0);
        const totalCents = goods + o.deliveryCents + (o.marginCents ?? 0);
        const [order] = await tx
          .insert(schema.orders)
          .values({
            reference: nextRef(o.shopId),
            shopId: o.shopId,
            userId: o.userId,
            customerName: o.who.name,
            email: o.who.email,
            phone: o.who.phone,
            qty: o.lines.reduce((s, l) => s + l.qty, 0),
            totalCents,
            deliveryCents: o.deliveryCents,
            status: o.plan.status,
            channel: 'Store',
            commerceMode: o.mode,
            buyerShop: o.resellerShop
              ? {
                  name: o.resellerShop.name,
                  handle: o.resellerShop.handle,
                  supportPhone: o.resellerShop.supportPhone ?? undefined,
                }
              : undefined,
            resellerShopId: o.resellerShop?.id,
            resellerListingId: o.listingId,
            resellerMarginCents: o.marginCents ?? 0,
            tradeQuoteId: o.quoteId ?? null,
            address: {
              line: 'Village road, near the bazar',
              area: o.who.area,
              pincode: '1700',
            },
            placedAt,
            ...lifecycle(o.plan.status, placedAt),
          })
          .returning({ id: schema.orders.id });
        await tx.insert(schema.orderItems).values(
          o.lines.map((l) => ({
            orderId: order.id,
            productId: l.productId,
            name: l.name,
            qty: l.qty,
            units: l.qty,
            unitPriceCents: l.unitCents,
          })),
        );
        if (o.dispute)
          await tx.insert(schema.tradeDisputes).values({
            orderId: order.id,
            buyerId: o.dispute.buyerId,
            shopId: o.shopId,
            reason: o.dispute.reason,
            status: 'open',
            createdAt: ago(o.plan.age - 3 * DAY),
          });
        built.push({ shopId: o.shopId, ...o.who, totalCents, placedAt });
      };

      for (const plan of WHOLESALE_PLANS) {
        jobs.push({
          placedAt: ago(plan.age),
          run: () => {
            const b = BUYERS[plan.buyer];
            return insertOrder({
              shopId: target.id,
              plan,
              mode: 'wholesale',
              userId: buyers[plan.buyer].id,
              who: {
                name: `${b.name} (${b.person})`,
                email: b.email,
                phone: buyers[plan.buyer].phone ?? fakePhone(),
                area: b.area,
              },
              lines: plan.lines.map(([n, qty]) => {
                const p = humriProducts.get(n)!;
                return {
                  productId: p.id,
                  name: n,
                  qty,
                  unitCents: cents(plan.quote ? 2480 : tier(p.item, qty)),
                };
              }),
              deliveryCents: cents(1500),
              quoteId: plan.quote ? wonQuoteId : null,
              dispute: plan.dispute
                ? { buyerId: buyers[plan.buyer].id, reason: plan.dispute }
                : undefined,
            });
          },
        });
      }
      const resold = (
        plan: Plan & { person: number },
        supplierId: string,
        resellerShop: typeof partner,
        products: typeof humriProducts,
      ) => ({
        placedAt: ago(plan.age),
        run: () => {
          const lines = plan.lines.map(([n, qty]) => ({
            l: listing.get(n)!,
            p: products.get(n)!,
            qty,
          }));
          return insertOrder({
            shopId: supplierId,
            plan,
            mode: 'reseller',
            who: person(plan.person),
            resellerShop,
            listingId: lines[0].l.id,
            lines: lines.map(({ l, p, qty }) => ({
              productId: p.id,
              name: p.item.name,
              qty,
              unitCents: l.supplyCents,
            })),
            marginCents: lines.reduce(
              (s, { l, qty }) => s + (l.sellCents - l.supplyCents) * qty,
              0,
            ),
            deliveryCents: cents(120),
          });
        },
      });
      for (const plan of VIA_PARTNER)
        jobs.push(resold(plan, target.id, partner, humriProducts));
      for (const plan of HUMRI_RESOLD)
        jobs.push(resold(plan, partner.id, target, partnerProducts));
      for (const j of jobs.sort(
        (a, b) => a.placedAt.getTime() - b.placedAt.getTime(),
      ))
        await j.run();

      console.log('Recording customers…');
      const groups = new Map<string, Built[]>();
      for (const b of built)
        groups.set(`${b.shopId}|${b.email}`, [
          ...(groups.get(`${b.shopId}|${b.email}`) ?? []),
          b,
        ]);
      for (const list of groups.values()) {
        const first = list.reduce((a, b) => (a.placedAt < b.placedAt ? a : b));
        const last = list.reduce((a, b) => (a.placedAt > b.placedAt ? a : b));
        const spent = list.reduce((s, b) => s + b.totalCents, 0);
        const [c] = await tx
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
          .set({ customerId: c.id })
          .where(
            and(
              eq(schema.orders.shopId, first.shopId),
              eq(schema.orders.email, first.email),
            ),
          );
      }

      // Keep the target's sales credit where it was (see the header).
      const offset = built
        .filter((b) => b.shopId === target.id)
        .reduce((s, b) => s + b.totalCents, 0);
      await tx
        .update(schema.subscriptions)
        .set({
          creditGrantedCents: sql`${schema.subscriptions.creditGrantedCents} + ${offset}`,
        })
        .where(eq(schema.subscriptions.shopId, target.id));

      const onTarget = built.filter((b) => b.shopId === target.id).length;
      console.log(
        `\n✅ ${target.name}: ${HUMRI_ITEMS.length} trade products, ${onTarget} orders to ship, ${HUMRI_RESOLD.length} resold orders, ${QUOTES.length} quotes, ${HUMRI_RESELLS.length} resell listings.`,
      );
      console.log(
        `   Credit grant raised by ৳${offset / 100} to cover the demo orders (reversed on --remove).`,
      );
      console.log(`   Partner: https://hoomri.com/shop/${PARTNER_HANDLE}`);
      if (dryRun) throw new DryRun();
    });
    if (partnerPassword && !remove)
      console.log(
        `   Partner login: ${PARTNER_OWNER.email}  ${partnerPassword}`,
      );
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
