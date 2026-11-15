import { BadRequestException } from '@nestjs/common';
import { SettlementsService } from './settlements.service';
import type { DrizzleDB } from '../../database/drizzle.types';
import type { ShopsService } from '../shops/shops.service';
import type { PaymentMethodsService } from './payment-methods.service';

/**
 * What the operator's settlements screen offers them.
 *
 * A payout follows the goods, so a shop's money sits in the cycle its
 * parcels arrived in - which may be the one still collecting. The screen has
 * to put every shop with a delivered order somewhere the operator can find
 * it, and let them record the transfer whenever they actually make it,
 * rather than only after a cycle has closed.
 */

const DHAKA_NOON = (iso: string) => new Date(`${iso}T06:00:00.000Z`);

/** One delivered, fully prepaid order. */
const order = (shopId: string, deliveredOn: string, cents: number) => ({
  shopId,
  paymentMethod: 'mbank',
  totalCents: cents,
  advanceCents: 0,
  pay: 'Paid',
  deliveredAt: DHAKA_NOON(deliveredOn),
  handedOverAt: null,
  deliveryMode: 'carrybee' as const,
});

/** One recorded payout of that cycle, as the snapshot row holds it. */
const PAID_SNAPSHOT = {
  shopId: 'shop-a',
  period: '2026-10',
  ordersCount: 1,
  totalCents: 5000,
  codCents: 0,
  mbankCents: 5000,
  cardCents: 0,
  otherCents: 0,
  feeCents: 150,
  payoutCents: 4850,
  mbankFeeBp: 300,
  cardFeeBp: 350,
  breakdown: [
    {
      code: 'mbank',
      title: 'Mobile banking',
      cents: 5000,
      feeBp: 300,
      feeCents: 150,
    },
  ],
  note: null,
  paidAt: new Date('2026-09-22T06:00:00.000Z'),
};

const SHOPS = [
  { id: 'shop-a', name: 'Anar', handle: 'anar', currency: 'BDT' },
  { id: 'shop-b', name: 'Bokul', handle: 'bokul', currency: 'BDT' },
];

function serviceWith(opts: {
  orders: ReturnType<typeof order>[];
  settlements?: Record<string, unknown>[];
  dues?: Record<string, number>;
  paymentLinks?: {
    shopId: string;
    amountCents?: number;
    currency?: string;
    settledAmountCents: number;
    paymentMethod: string | null;
    paidAt: Date;
  }[];
}) {
  const db = {
    query: {
      orders: { findMany: jest.fn().mockResolvedValue(opts.orders) },
      paymentLinks: {
        findMany: jest.fn().mockResolvedValue(opts.paymentLinks ?? []),
      },
      settlements: {
        findMany: jest.fn().mockResolvedValue(opts.settlements ?? []),
      },
      // The real query is filtered to the shops in the selected cycle; the
      // mock stands in for that by knowing only the shops in play here.
      shops: {
        findMany: jest.fn().mockImplementation(() => {
          const inPlay = new Set([
            ...opts.orders.map((o) => o.shopId),
            ...(opts.settlements ?? []).map((s) => s.shopId as string),
            ...(opts.paymentLinks ?? []).map((l) => l.shopId),
          ]);
          return Promise.resolve(SHOPS.filter((s) => inPlay.has(s.id)));
        }),
      },
    },
  } as unknown as DrizzleDB;

  // Payout decisions now read under the same row lock as reconciliation.
  Object.assign(db, {
    transaction: (work: (tx: DrizzleDB) => unknown) => work(db),
    select: (fields: Record<string, unknown>) => ({
      from: () => {
        if ('id' in fields)
          return { where: () => ({ for: async () => [{ id: 'shop-a' }] }) };
        if ('code' in fields)
          return Promise.resolve([
            { code: 'mbank', gateway: 'sslcommerz' },
            { code: 'cod', gateway: 'none' },
          ]);
        return { where: async () => [{ cents: 0 }] };
      },
    }),
  });

  const methods = {
    byCode: jest.fn().mockResolvedValue(
      new Map([
        [
          'mbank',
          {
            code: 'mbank',
            kind: 'mbank',
            title: 'Mobile banking',
            feeBp: 300,
            gateway: 'sslcommerz',
          },
        ],
        [
          'cod',
          {
            code: 'cod',
            kind: 'cod',
            title: 'Cash on Delivery',
            feeBp: 0,
            gateway: 'none',
          },
        ],
      ]),
    ),
  } as unknown as PaymentMethodsService;

  // What each shop owes back on money it collected itself, in paisa.
  const serviceFees = {
    balancesFor: jest
      .fn()
      .mockResolvedValue(new Map(Object.entries(opts.dues ?? {}))),
  };

  return new SettlementsService(
    db,
    {} as ShopsService,
    methods,
    serviceFees as never,
  );
}

/**
 * A paid payment link is money the platform is holding for a shop, exactly as
 * a prepaid order is - but there is no parcel, so nothing ever "delivers" it.
 * It has to reach a payout on the strength of having been paid.
 */
describe('paid payment links in a payout', () => {
  beforeAll(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-24T04:00:00.000Z'));
  });
  afterAll(() => jest.useRealTimers());

  it('pays out a link in the cycle it was paid in, less the method fee', async () => {
    const service = serviceWith({
      orders: [],
      paymentLinks: [
        {
          shopId: 'shop-a',
          settledAmountCents: 10_000,
          paymentMethod: 'mbank',
          paidAt: DHAKA_NOON('2026-09-20'),
        },
      ],
    });

    const { period, rows } = await service.forPlatform();

    expect(period).toBe('2026-10');
    expect(rows).toHaveLength(1);
    expect(rows[0].shopId).toBe('shop-a');
    // 3% of ৳100.
    expect(rows[0].payout).toBe(97);
  });

  it('pays out a USD link using its captured BDT value', async () => {
    const service = serviceWith({
      orders: [],
      paymentLinks: [
        {
          shopId: 'shop-a',
          currency: 'USD',
          amountCents: 1000,
          settledAmountCents: 122000,
          paymentMethod: 'mbank',
          paidAt: DHAKA_NOON('2026-09-20'),
        },
      ],
    });
    const { rows } = await service.forPlatform('2026-10');
    expect(rows[0].payout).toBe(1183.4); // BDT 1220 less 3%.
  });

  it('adds a link to the same payout as the shop’s orders', async () => {
    const service = serviceWith({
      orders: [order('shop-a', '2026-09-20', 5000)],
      paymentLinks: [
        {
          shopId: 'shop-a',
          settledAmountCents: 10_000,
          paymentMethod: 'mbank',
          paidAt: DHAKA_NOON('2026-09-21'),
        },
      ],
    });

    const { rows } = await service.forPlatform('2026-10');

    expect(rows[0].total).toBe(150);
    expect(rows[0].payout).toBe(145.5);
  });
});

describe('the cycles the settlements screen offers', () => {
  // Today is 24 Sep 2026, so the cycle now collecting is October's.
  beforeAll(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-24T04:00:00.000Z'));
  });
  afterAll(() => jest.useRealTimers());

  it('offers a cycle a delivery landed in, even one still collecting', async () => {
    // Delivered on the 20th: after the 15th, so it belongs to October's payout.
    const service = serviceWith({
      orders: [order('shop-a', '2026-09-20', 5000)],
    });

    const { periods } = await service.forPlatform();

    expect(periods).toContain('2026-10');
  });

  it('lands the operator on the newest cycle that still owes somebody', async () => {
    const service = serviceWith({
      orders: [
        order('shop-a', '2026-09-20', 5000), // → 2026-10, unpaid
        order('shop-b', '2026-08-02', 3000), // → 2026-08, unpaid
      ],
    });

    const { period, unsettled } = await service.forPlatform();

    expect(period).toBe('2026-10');
    expect(unsettled).toEqual(['2026-10', '2026-08']);
  });

  it('shows the shop whose parcels arrived in the cycle it opens on', async () => {
    const service = serviceWith({
      orders: [order('shop-a', '2026-09-20', 5000)],
    });

    const { rows } = await service.forPlatform();

    expect(rows).toHaveLength(1);
    expect(rows[0].shopId).toBe('shop-a');
    expect(rows[0].payout).toBeGreaterThan(0);
    // Still collecting - which says more may join it, not that it is closed.
    expect(rows[0].status).toBe('accruing');
  });

  it('does not count a cycle as owing when its money was cash on delivery', async () => {
    const cash = {
      ...order('shop-a', '2026-09-20', 5000),
      paymentMethod: 'cod',
    };
    const service = serviceWith({ orders: [cash] });

    const { unsettled, rows } = await service.forPlatform();

    expect(unsettled).toEqual([]);
    expect(rows[0].status).toBe('none');
  });

  it('leaves a settled cycle out of the ones still owing', async () => {
    const service = serviceWith({
      orders: [order('shop-a', '2026-09-20', 5000)],
      settlements: [PAID_SNAPSHOT],
    });

    const { unsettled, rows } = await service.forPlatform();

    expect(unsettled).toEqual([]);
    expect(rows[0].status).toBe('paid');
    expect(rows[0].unrecorded).toBeUndefined();
  });

  it('says how much has arrived since a still-open cycle was paid out', async () => {
    const service = serviceWith({
      orders: [
        order('shop-a', '2026-09-20', 5000), // covered by the snapshot below
        order('shop-a', '2026-09-23', 2000), // delivered after it was paid
      ],
      settlements: [PAID_SNAPSHOT],
    });

    const { rows, totals, unsettled } = await service.forPlatform();

    // 7000 collected in the cycle, 3% fee -> 6790 owed; 4850 of it is paid.
    expect(rows[0].payout).toBe(48.5);
    expect(rows[0].unrecorded).toBe(19.4);
    // The part the snapshot does not cover is still money to pay out, so the
    // cycle counts as owing again however many times it has been settled.
    expect(totals[0].paidPayout).toBe(48.5);
    expect(totals[0].pendingPayout).toBe(19.4);
    expect(unsettled).toEqual(['2026-10']);
  });

  it('carries a receipt as a name and an amount, never as the file', async () => {
    const service = serviceWith({
      orders: [order('shop-a', '2026-09-20', 5000)],
      settlements: [
        {
          ...PAID_SNAPSHOT,
          proofs: [
            {
              data: 'data:application/pdf;base64,JVBERi0=',
              name: 'bkash-oct.pdf',
              payoutCents: 4850,
              at: '2026-09-22T06:00:00.000Z',
            },
          ],
        },
      ],
    });

    const { rows } = await service.forPlatform();

    expect(rows[0].receipts).toEqual([
      {
        index: 0,
        name: 'bkash-oct.pdf',
        at: '2026-09-22T06:00:00.000Z',
        payout: 48.5,
        mime: 'application/pdf',
      },
    ]);
    // The document is megabytes and a history is a row per month.
    expect(JSON.stringify(rows[0])).not.toContain('JVBERi0=');
  });

  it('leaves receipts off a cycle nobody has been paid for', async () => {
    const service = serviceWith({
      orders: [order('shop-a', '2026-09-20', 5000)],
    });

    const { rows } = await service.forPlatform();

    expect(rows[0].receipts).toBeUndefined();
  });

  it('ignores an order that has not been delivered yet', async () => {
    const undelivered = {
      ...order('shop-a', '2026-09-20', 5000),
      deliveredAt: null,
    };
    const service = serviceWith({ orders: [undelivered] });

    const { unsettled, rows } = await service.forPlatform();

    expect(unsettled).toEqual([]);
    expect(rows).toEqual([]);
  });
});

/**
 * The receipt is the seller's only way to check that money they were told
 * about actually arrived, so a payout cannot be recorded without one. The
 * guard runs before any of the payout maths, which is why this needs nothing
 * of the database.
 */
describe('recording a payout', () => {
  beforeAll(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-24T04:00:00.000Z'));
  });
  afterAll(() => jest.useRealTimers());

  // A shop with ৳9,700 waiting in a closed cycle.
  const service = () => {
    const svc = serviceWith({
      orders: [order('shop-a', '2026-08-20', 1_000_000)],
    });
    (svc as unknown as { shops: unknown }).shops = {
      requireById: jest.fn().mockResolvedValue(SHOPS[0]),
    };
    return svc;
  };

  it('refuses without a receipt for the transfer', async () => {
    await expect(
      service().decide('shop-a', '2026-09', true),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('names what is missing rather than failing vaguely', async () => {
    await expect(service().decide('shop-a', '2026-09', true)).rejects.toThrow(
      /receipt/i,
    );
  });

  it('asks for nothing extra to undo one', async () => {
    // Undoing deletes the row - there is no transfer to evidence.
    const db: Record<string, any> = {
      query: { settlements: { findFirst: async () => undefined } },
      select: () => ({
        from: () => ({
          where: () => ({ for: async () => [{ id: 'shop-a' }] }),
        }),
      }),
      delete: () => ({
        where: () => ({ returning: () => Promise.resolve([]) }),
      }),
    };
    db.transaction = (work: (tx: unknown) => unknown) => work(db);
    const undo = new SettlementsService(
      db as never,
      { requireById: jest.fn().mockResolvedValue(SHOPS[0]) } as never,
      { byCode: async () => new Map() } as never,
    );

    // Reaches the "nothing to undo" case, so it got past any proof check.
    await expect(undo.decide('shop-a', '2026-09', false)).rejects.toThrow(
      /has not been marked paid/i,
    );
  });
});

/**
 * A transfer of a few taka costs more to make than it is worth, so a shop
 * is paid once what it is owed reaches the minimum. Nothing is lost in the
 * meantime: small cycles are held and ride along with the payout that takes
 * the total over.
 */
describe('the minimum payout', () => {
  beforeAll(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-24T04:00:00.000Z'));
  });
  afterAll(() => jest.useRealTimers());

  it('holds a closed cycle that is under the minimum on its own', async () => {
    const service = serviceWith({
      orders: [order('shop-a', '2026-08-02', 150_000)], // ৳1,500 → 2026-08
    });

    const { rows, minPayout } = await service.forPlatform('2026-08');

    expect(minPayout).toBe(2000);
    expect(rows[0].status).toBe('held');
    expect(rows[0].payout).toBe(1455);
  });

  it('releases held cycles the month they reach the minimum together', async () => {
    const service = serviceWith({
      orders: [
        order('shop-a', '2026-07-20', 150_000), // → 2026-08
        order('shop-a', '2026-08-20', 100_000), // → 2026-09
      ],
    });

    const { rows } = await service.forPlatform('2026-09');

    // ৳1,455 + ৳970 is over the minimum, so neither is held any more...
    expect(rows[0].status).not.toBe('held');
    // ...and paying September carries August with it.
    expect(rows[0].payout).toBe(970);
    expect(rows[0].carried).toBe(1455);
    expect(rows[0].transfer).toBe(2425);
  });

  it('never counts a cycle that is still collecting towards it', async () => {
    const service = serviceWith({
      orders: [
        order('shop-a', '2026-08-02', 150_000), // closed, ৳1,455
        order('shop-a', '2026-09-20', 900_000), // → 2026-10, still open
      ],
    });

    const { rows } = await service.forPlatform('2026-08');

    expect(rows[0].status).toBe('held');
  });

  it('refuses to record a payout that is under it', async () => {
    const service = serviceWith({
      orders: [order('shop-a', '2026-08-02', 150_000)],
    });
    (service as unknown as { shops: unknown }).shops = {
      requireById: jest.fn().mockResolvedValue(SHOPS[0]),
    };

    await expect(
      service.decide('shop-a', '2026-08', true, undefined, {
        data: 'data:application/pdf;base64,AAAA',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ error: 'BelowMinimumPayout' }),
    });
  });
});

/**
 * A shop that collected cash owes the platform its service fee - and, on a
 * reseller's order, the margin it is holding. When the platform also owes
 * that shop a payout, the one is taken from the other rather than sending
 * money out and asking for some of it back.
 */
describe('what a shop owes, against its payout', () => {
  beforeAll(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-24T04:00:00.000Z'));
  });
  afterAll(() => jest.useRealTimers());

  it('shows the transfer net of the balance before anything is recorded', async () => {
    const service = serviceWith({
      orders: [order('shop-a', '2026-08-02', 1_000_000)], // payout ৳9,700
      dues: { 'shop-a': 250_000 },
    });

    const { rows } = await service.forPlatform('2026-08');

    expect(rows[0].payout).toBe(9700);
    expect(rows[0].duesOutstanding).toBe(2500);
    expect(rows[0].transfer).toBe(7200);
  });

  it('never keeps back more than the payout holds', async () => {
    const service = serviceWith({
      orders: [order('shop-a', '2026-08-02', 1_000_000)],
      dues: { 'shop-a': 5_000_000 },
    });

    const { rows } = await service.forPlatform('2026-08');

    expect(rows[0].duesOutstanding).toBe(9700);
    expect(rows[0].transfer).toBe(0);
  });

  it('ignores a shop that is in credit', async () => {
    const service = serviceWith({
      orders: [order('shop-a', '2026-08-02', 1_000_000)],
      dues: { 'shop-a': -40_000 },
    });

    const { rows } = await service.forPlatform('2026-08');

    expect(rows[0].duesOutstanding).toBeUndefined();
    expect(rows[0].transfer).toBe(9700);
  });

  it('reads a paid cycle from what was actually kept back', async () => {
    const service = serviceWith({
      orders: [],
      settlements: [
        {
          ...PAID_SNAPSHOT,
          period: '2026-08',
          payoutCents: 970_000,
          duesDeductedCents: 250_000,
        },
      ],
      dues: { 'shop-a': 999_999 },
    });

    const { rows } = await service.forPlatform('2026-08');

    expect(rows[0].duesDeducted).toBe(2500);
    expect(rows[0].transfer).toBe(7200);
    expect(rows[0].duesOutstanding).toBeUndefined();
  });
});
