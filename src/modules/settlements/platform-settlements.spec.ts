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

const SHOPS = [
  { id: 'shop-a', name: 'Anar', handle: 'anar', currency: 'BDT' },
  { id: 'shop-b', name: 'Bokul', handle: 'bokul', currency: 'BDT' },
];

function serviceWith(opts: {
  orders: ReturnType<typeof order>[];
  settlements?: Record<string, unknown>[];
}) {
  const db = {
    query: {
      orders: { findMany: jest.fn().mockResolvedValue(opts.orders) },
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
          ]);
          return Promise.resolve(SHOPS.filter((s) => inPlay.has(s.id)));
        }),
      },
    },
  } as unknown as DrizzleDB;

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

  return new SettlementsService(db, {} as ShopsService, methods);
}

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
      settlements: [
        {
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
        },
      ],
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
      settlements: [
        {
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
        },
      ],
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
