import 'dotenv/config';
import * as bcrypt from 'bcryptjs';
import { drizzle } from 'drizzle-orm/postgres-js';
import { authenticator } from 'otplib';
import postgres from 'postgres';
import {
  DEFAULT_MONTHLY_FEE_CENTS,
  ENTRY_PLAN_CODE,
  PLAN_TIERS,
} from '../common/constants/billing';
import { BRAND_SWATCHES } from '../common/constants/brand-swatches';
import { dollarsToCents } from '../common/utils/money.util';
import { handleize } from '../common/utils/slug.util';
import * as schema from './schema';
import type {
  CustomerSegment,
  OrderStatus,
  PaymentStatus,
  ProductTag,
  SalesChannel,
} from './schema/enums';

/**
 * Seeds the database with the prototype's "Mango Shop" demo dataset
 * (transcribed from design-reference/data.jsx). Idempotent: it clears the
 * domain tables first, then re-inserts a consistent graph of
 * user → shop → products → reviews → customers → orders, plus an admin account.
 */

const PRODUCTS: {
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
}[] = [
  {
    name: 'Alphonso Mango Box',
    cat: 'Mangoes',
    price: 38,
    unit: 'box of 12',
    stock: 46,
    emoji: '🥭',
    tone: '#fbeede',
    tag: 'Bestseller',
    rating: 4.9,
    reviews: 312,
    blurb:
      'The king of mangoes — buttery, fragrant Ratnagiri Alphonsos, hand-picked and ripened naturally.',
  },
  {
    name: 'Kesar Mango Box',
    cat: 'Mangoes',
    price: 32,
    unit: 'box of 12',
    stock: 30,
    emoji: '🥭',
    tone: '#f8eed5',
    tag: 'In season',
    rating: 4.8,
    reviews: 188,
    blurb: 'Saffron-hued Gir Kesar mangoes with a rich, honeyed sweetness.',
  },
  {
    name: 'Mango Gift Hamper',
    cat: 'Gifting',
    price: 64,
    unit: 'hamper',
    stock: 18,
    emoji: '🎁',
    tone: '#f6dfc2',
    tag: 'Gift',
    rating: 5.0,
    reviews: 74,
    blurb:
      'A premium hamper: 6 Alphonsos, mango pulp, dried slices & a handwritten note.',
  },
  {
    name: 'Fresh Lychees',
    cat: 'Fruits',
    price: 14,
    unit: '500g',
    stock: 52,
    emoji: '🍇',
    tone: '#f7e2dd',
    rating: 4.7,
    reviews: 96,
    blurb: 'Juicy, floral lychees picked at peak ripeness.',
  },
  {
    name: 'Tender Coconut',
    cat: 'Fruits',
    price: 6,
    unit: 'each',
    stock: 120,
    emoji: '🥥',
    tone: '#eef0ea',
    rating: 4.6,
    reviews: 140,
    blurb: 'Chilled tender coconuts, full of sweet water.',
  },
  {
    name: 'Custard Apple',
    cat: 'Fruits',
    price: 11,
    unit: '4 pcs',
    stock: 0,
    emoji: '🍏',
    tone: '#e2f1e8',
    rating: 4.5,
    reviews: 58,
    blurb: 'Creamy sitaphal, naturally sweet — back soon.',
  },
  {
    name: 'Dried Mango Slices',
    cat: 'Pantry',
    price: 9,
    unit: '200g pack',
    stock: 88,
    emoji: '🍯',
    tone: '#f8eed5',
    tag: 'Snack',
    rating: 4.8,
    reviews: 210,
    blurb: 'Chewy, no-sugar-added dried Alphonso slices.',
  },
  {
    name: 'Mango Pulp Tin',
    cat: 'Pantry',
    price: 8,
    unit: '850g tin',
    stock: 64,
    emoji: '🥫',
    tone: '#fbeede',
    rating: 4.7,
    reviews: 133,
    blurb: 'Smooth sweetened Alphonso pulp for shakes & desserts.',
  },
  {
    name: 'Mango Pickle',
    cat: 'Pantry',
    price: 7,
    unit: '400g jar',
    stock: 41,
    emoji: '🫙',
    tone: '#f7e2dd',
    rating: 4.6,
    reviews: 87,
    blurb: 'Tangy, spicy raw-mango pickle, made in small batches.',
  },
  {
    name: 'Banganapalli Mango',
    cat: 'Mangoes',
    price: 28,
    unit: 'box of 12',
    stock: 24,
    emoji: '🥭',
    tone: '#f8eed5',
    rating: 4.5,
    reviews: 64,
    blurb: 'Large, firm, mildly sweet — great for slicing.',
  },
  {
    name: 'Seasonal Fruit Basket',
    cat: 'Gifting',
    price: 42,
    unit: 'basket',
    stock: 15,
    emoji: '🧺',
    tone: '#eef0ea',
    tag: 'Gift',
    rating: 4.9,
    reviews: 51,
    blurb: "A curated basket of whatever's freshest this week.",
  },
  {
    name: 'Mango Lassi Kit',
    cat: 'Pantry',
    price: 16,
    unit: 'makes 6',
    stock: 33,
    emoji: '🥛',
    tone: '#fbeede',
    tag: 'New',
    rating: 4.8,
    reviews: 29,
    blurb: 'Everything you need for café-style mango lassi at home.',
  },
];

const ORDERS: {
  ref: string;
  customer: string;
  email: string;
  items: [string, number][];
  qty: number;
  total: number;
  status: OrderStatus;
  date: string;
  pay: PaymentStatus;
  channel: SalesChannel;
}[] = [
  {
    ref: '#1042',
    customer: 'Nusrat Jahan',
    email: 'nusrat.jahan@gmail.com',
    items: [
      ['Alphonso Mango Box', 1],
      ['Mango Lassi Kit', 1],
    ],
    qty: 2,
    total: 54,
    status: 'New',
    date: '2026-06-08',
    pay: 'Paid',
    channel: 'Instagram',
  },
  {
    ref: '#1041',
    customer: 'Daniel Cho',
    email: 'dan.cho@outlook.com',
    items: [['Mango Gift Hamper', 1]],
    qty: 1,
    total: 64,
    status: 'Packed',
    date: '2026-06-08',
    pay: 'Paid',
    channel: 'Store',
  },
  {
    ref: '#1040',
    customer: 'Aisha Khan',
    email: 'aisha.k@gmail.com',
    items: [['Kesar Mango Box', 2]],
    qty: 2,
    total: 64,
    status: 'New',
    date: '2026-06-07',
    pay: 'Paid',
    channel: 'WhatsApp',
  },
  {
    ref: '#1039',
    customer: 'Marco Rossi',
    email: 'marco.r@gmail.com',
    items: [
      ['Dried Mango Slices', 2],
      ['Mango Pickle', 1],
    ],
    qty: 3,
    total: 25,
    status: 'Shipped',
    date: '2026-06-07',
    pay: 'Paid',
    channel: 'Store',
  },
  {
    ref: '#1038',
    customer: 'Nusrat Jahan',
    email: 'nusrat.jahan@gmail.com',
    items: [['Tender Coconut', 4]],
    qty: 4,
    total: 24,
    status: 'Delivered',
    date: '2026-06-05',
    pay: 'Paid',
    channel: 'Store',
  },
  {
    ref: '#1037',
    customer: 'Sara Lopez',
    email: 'sara.lopez@gmail.com',
    items: [['Fresh Lychees', 2]],
    qty: 2,
    total: 28,
    status: 'Delivered',
    date: '2026-06-05',
    pay: 'Paid',
    channel: 'Instagram',
  },
  {
    ref: '#1036',
    customer: 'Daniel Cho',
    email: 'dan.cho@outlook.com',
    items: [['Alphonso Mango Box', 1]],
    qty: 1,
    total: 38,
    status: 'Delivered',
    date: '2026-06-04',
    pay: 'Paid',
    channel: 'Store',
  },
  {
    ref: '#1035',
    customer: 'Tomás Vega',
    email: 'tomas.v@gmail.com',
    items: [['Mango Pulp Tin', 3]],
    qty: 3,
    total: 24,
    status: 'Delivered',
    date: '2026-06-03',
    pay: 'Refunded',
    channel: 'WhatsApp',
  },
  {
    ref: '#1034',
    customer: 'Aisha Khan',
    email: 'aisha.k@gmail.com',
    items: [['Seasonal Fruit Basket', 1]],
    qty: 1,
    total: 42,
    status: 'Delivered',
    date: '2026-06-02',
    pay: 'Paid',
    channel: 'Store',
  },
  {
    ref: '#1033',
    customer: 'Nusrat Jahan',
    email: 'nusrat.jahan@gmail.com',
    items: [
      ['Mango Gift Hamper', 1],
      ['Dried Mango Slices', 1],
    ],
    qty: 2,
    total: 73,
    status: 'Delivered',
    date: '2026-05-30',
    pay: 'Paid',
    channel: 'Store',
  },
  {
    ref: '#1032',
    customer: 'Lena Müller',
    email: 'lena.m@gmail.com',
    items: [['Banganapalli Mango', 1]],
    qty: 1,
    total: 28,
    status: 'Delivered',
    date: '2026-05-29',
    pay: 'Paid',
    channel: 'Instagram',
  },
  {
    ref: '#1031',
    customer: 'Sara Lopez',
    email: 'sara.lopez@gmail.com',
    items: [
      ['Mango Lassi Kit', 1],
      ['Tender Coconut', 2],
    ],
    qty: 3,
    total: 28,
    status: 'Delivered',
    date: '2026-05-27',
    pay: 'Paid',
    channel: 'Store',
  },
];

const CUSTOMERS: {
  name: string;
  email: string;
  phone: string;
  city: string;
  orders: number;
  spent: number;
  last: string;
  first: string;
  segment: CustomerSegment;
}[] = [
  {
    name: 'Nusrat Jahan',
    email: 'nusrat.jahan@gmail.com',
    phone: '+1 512-555-0142',
    city: 'Austin, TX',
    orders: 4,
    spent: 205,
    last: '2026-06-08',
    first: '2026-03-12',
    segment: 'Repeat',
  },
  {
    name: 'Daniel Cho',
    email: 'dan.cho@outlook.com',
    phone: '+1 206-555-0117',
    city: 'Seattle, WA',
    orders: 3,
    spent: 166,
    last: '2026-06-08',
    first: '2026-04-02',
    segment: 'Repeat',
  },
  {
    name: 'Aisha Khan',
    email: 'aisha.k@gmail.com',
    phone: '+1 312-555-0186',
    city: 'Chicago, IL',
    orders: 3,
    spent: 148,
    last: '2026-06-07',
    first: '2026-04-20',
    segment: 'Repeat',
  },
  {
    name: 'Sara Lopez',
    email: 'sara.lopez@gmail.com',
    phone: '+1 305-555-0163',
    city: 'Miami, FL',
    orders: 3,
    spent: 84,
    last: '2026-06-05',
    first: '2026-05-01',
    segment: 'Repeat',
  },
  {
    name: 'Marco Rossi',
    email: 'marco.r@gmail.com',
    phone: '+1 617-555-0129',
    city: 'Boston, MA',
    orders: 2,
    spent: 51,
    last: '2026-06-07',
    first: '2026-05-10',
    segment: 'Repeat',
  },
  {
    name: 'Tomás Vega',
    email: 'tomas.v@gmail.com',
    phone: '+1 720-555-0154',
    city: 'Denver, CO',
    orders: 1,
    spent: 24,
    last: '2026-06-03',
    first: '2026-06-03',
    segment: 'New',
  },
  {
    name: 'Lena Müller',
    email: 'lena.m@gmail.com',
    phone: '+1 503-555-0171',
    city: 'Portland, OR',
    orders: 1,
    spent: 28,
    last: '2026-05-29',
    first: '2026-05-29',
    segment: 'New',
  },
  {
    name: 'Owen Park',
    email: 'owen.park@gmail.com',
    phone: '+1 408-555-0195',
    city: 'San Jose, CA',
    orders: 1,
    spent: 38,
    last: '2026-05-22',
    first: '2026-05-22',
    segment: 'New',
  },
];

async function seed(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  const client = postgres(url, { max: 1 });
  const db = drizzle(client, { schema });

  try {
    console.log('Clearing existing data…');
    await db.delete(schema.subscriptionPayments);
    await db.delete(schema.subscriptions);
    await db.delete(schema.orderItems);
    await db.delete(schema.orders);
    await db.delete(schema.reviews);
    await db.delete(schema.products);
    await db.delete(schema.customers);
    await db.delete(schema.adminUsers);
    await db.delete(schema.shops);
    await db.delete(schema.users);

    // The plan ladder is seeded by migration 0058 and re-priceable by the
    // operator, so it is topped up rather than wiped with the demo data.
    console.log('Ensuring the subscription plan ladder…');
    await db
      .insert(schema.subscriptionPlans)
      .values(
        PLAN_TIERS.map((tier, i) => ({
          code: tier.code,
          name: tier.name,
          salesCapCents: tier.salesCapCents,
          priceCents: tier.priceCents,
          sortOrder: i + 1,
        })),
      )
      .onConflictDoNothing({ target: schema.subscriptionPlans.code });

    console.log('Creating owner + shop…');
    const passwordHash = await bcrypt.hash('password123', 12);
    const [owner] = await db
      .insert(schema.users)
      .values({
        name: 'Maya Rahman',
        email: 'maya@mango-shop.com',
        passwordHash,
        via: 'email',
        emailVerified: true,
      })
      .returning();

    const amber = BRAND_SWATCHES.amber;
    const [shop] = await db
      .insert(schema.shops)
      .values({
        name: 'Mango Shop',
        handle: 'mango-shop',
        tagline: 'Tropical fruit, delivered fresh.',
        cat: 'Food & grocery',
        brandId: 'amber',
        brand: amber.c,
        brandSoft: amber.soft,
        ownerId: owner.id,
      })
      .returning();

    console.log('Creating products…');
    const productByName = new Map<string, { id: string; priceCents: number }>();
    for (const p of PRODUCTS) {
      const [row] = await db
        .insert(schema.products)
        .values({
          shopId: shop.id,
          name: p.name,
          slug: handleize(p.name),
          cat: p.cat,
          priceCents: dollarsToCents(p.price),
          unit: p.unit,
          stock: p.stock,
          emoji: p.emoji,
          tone: p.tone,
          tag: p.tag,
          rating: p.rating,
          reviewsCount: p.reviews,
          blurb: p.blurb,
        })
        .returning({
          id: schema.products.id,
          priceCents: schema.products.priceCents,
        });
      productByName.set(p.name, row);
    }

    console.log('Creating reviews for the bestseller…');
    const hero = productByName.get('Alphonso Mango Box')!;
    await db.insert(schema.reviews).values([
      {
        productId: hero.id,
        author: 'Nusrat Jahan',
        rating: 5,
        body: 'Best mangoes I have had outside India. Perfectly ripe.',
        verified: true,
      },
      {
        productId: hero.id,
        author: 'Daniel Cho',
        rating: 5,
        body: 'Arrived next day, beautifully packed.',
        verified: true,
      },
      {
        productId: hero.id,
        author: 'Marco Rossi',
        rating: 4,
        body: 'Delicious, a couple were a touch soft.',
        verified: false,
      },
    ]);

    console.log('Creating customers…');
    const customerByEmail = new Map<string, string>();
    for (const c of CUSTOMERS) {
      const [row] = await db
        .insert(schema.customers)
        .values({
          shopId: shop.id,
          name: c.name,
          email: c.email,
          phone: c.phone,
          city: c.city,
          ordersCount: c.orders,
          spentCents: dollarsToCents(c.spent),
          firstOrderAt: new Date(c.first),
          lastOrderAt: new Date(c.last),
          segment: c.segment,
        })
        .returning({ id: schema.customers.id });
      customerByEmail.set(c.email, row.id);
    }

    console.log('Creating orders + line items…');
    for (const o of ORDERS) {
      const [order] = await db
        .insert(schema.orders)
        .values({
          reference: o.ref,
          shopId: shop.id,
          customerId: customerByEmail.get(o.email) ?? null,
          customerName: o.customer,
          email: o.email,
          qty: o.qty,
          totalCents: dollarsToCents(o.total),
          status: o.status,
          pay: o.pay,
          channel: o.channel,
          placedAt: new Date(o.date),
        })
        .returning({ id: schema.orders.id });

      for (const [name, qty] of o.items) {
        const product = productByName.get(name);
        await db.insert(schema.orderItems).values({
          orderId: order.id,
          productId: product?.id ?? null,
          name,
          qty,
          unitPriceCents: product?.priceCents ?? 0,
        });
      }
    }

    console.log('Creating platform subscription + payment history…');
    // Subscription anchored on the 12th: started 2026-03-12, two auto
    // renewals collected, next charge due 2026-06-12.
    const [subscription] = await db
      .insert(schema.subscriptions)
      .values({
        shopId: shop.id,
        ownerId: owner.id,
        status: 'active',
        planCode: ENTRY_PLAN_CODE,
        amountCents: DEFAULT_MONTHLY_FEE_CENTS,
        currency: 'BDT',
        autoDebit: true,
        startedAt: new Date('2026-03-12T10:00:00Z'),
        nextBillingAt: new Date('2026-06-12T10:00:00Z'),
      })
      .returning();
    await db.insert(schema.subscriptionPayments).values([
      {
        userId: owner.id,
        subscriptionId: subscription.id,
        shopId: shop.id,
        type: 'shop_creation',
        method: 'manual',
        planCode: ENTRY_PLAN_CODE,
        amountCents: DEFAULT_MONTHLY_FEE_CENTS,
        currency: 'BDT',
        paidAt: new Date('2026-03-12T10:00:00Z'),
        consumedAt: new Date('2026-03-12T10:00:00Z'),
      },
      ...(['2026-04-12', '2026-05-12'] as const).map((day, i, days) => ({
        userId: owner.id,
        subscriptionId: subscription.id,
        shopId: shop.id,
        type: 'renewal' as const,
        method: 'auto' as const,
        planCode: ENTRY_PLAN_CODE,
        amountCents: DEFAULT_MONTHLY_FEE_CENTS,
        currency: 'BDT',
        periodStart: new Date(`${day}T10:00:00Z`),
        periodEnd: new Date(`${days[i + 1] ?? '2026-06-12'}T10:00:00Z`),
        paidAt: new Date(`${day}T10:00:00Z`),
      })),
    ]);

    console.log('Creating admin account (with 2FA)…');
    const totpSecret = authenticator.generateSecret();
    const adminPasswordHash = await bcrypt.hash('admin12345', 12);
    await db.insert(schema.adminUsers).values({
      name: 'Maya Rahman',
      email: 'maya@mango-shop.com',
      passwordHash: adminPasswordHash,
      role: 'owner',
      shopId: shop.id,
      twoFactorEnabled: true,
      twoFactorSecret: totpSecret,
    });

    console.log('\n✅ Seed complete.\n');
    console.log('Seller login:  maya@mango-shop.com / password123');
    console.log('Storefront:    GET /api/shops/mango-shop');
    console.log('\nAdmin login (workspace = mango-shop):');
    console.log('  email:    maya@mango-shop.com');
    console.log('  password: admin12345');
    console.log(`  2FA TOTP secret: ${totpSecret}`);
    console.log(
      `  otpauth URL:     ${authenticator.keyuri('maya@mango-shop.com', 'Hoomri', totpSecret)}`,
    );
    console.log(`  current code:    ${authenticator.generate(totpSecret)}\n`);
  } finally {
    await client.end({ timeout: 5 });
  }
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
