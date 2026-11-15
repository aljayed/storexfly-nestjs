import type { SQL } from 'drizzle-orm';
import type { DrizzleDB } from '../../database/drizzle.types';
import type {
  SettlementRow,
  SettlementProof,
  ServiceFeePaymentRow,
} from '../../database/schema';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  paymentMethods,
  serviceFeePayments,
  settlements,
} from '../../database/schema';
import { SettlementsService } from './settlements.service';

const at = new Date('2026-12-04T06:00:00Z');
const shop = { id: 's', name: 'Shop', handle: 'shop', currency: 'BDT' };
const catalog = new Map([
  [
    'card',
    {
      code: 'card',
      title: 'Card',
      kind: 'card',
      gateway: 'sslcommerz',
      feeBp: 450,
    },
  ],
  [
    'cod',
    { code: 'cod', title: 'Cash', kind: 'cod', gateway: 'none', feeBp: 0 },
  ],
]);
function harness() {
  const delivered = (
    id: string,
    date: string,
    totalCents: number,
    paymentMethod = 'card',
    platformFeeBp = 0,
  ) => ({
    id,
    reference: id,
    shopId: 's',
    paymentMethod,
    platformFeeBp,
    totalCents,
    advanceCents: 0,
    resellerShopId: null,
    resellerMarginCents: 0,
    duesPaidAt: null,
    pay: 'Paid',
    deliveredAt: new Date(date),
    handedOverAt: null,
    deliveryMode: 'carrybee',
  });
  const orderRows = [
    delivered('old', '2026-10-20', 100_000),
    delivered('new', '2026-11-20', 400_000),
    delivered('cash', '2026-11-21', 1_000_000, 'cod', 450),
  ];
  type Paid = Pick<
    SettlementRow,
    'period' | 'payoutCents' | 'duesDeductedCents' | 'paidWithPeriod'
  > & { proofs: SettlementProof[] | null };
  type Payment = Pick<ServiceFeePaymentRow, 'amountCents' | 'payoutPeriod'>;
  const paidRows: Paid[] = [],
    payments: Payment[] = [];
  const dialect = new PgDialect();
  const periodsOf = (where: SQL): string[] =>
    dialect
      .sqlToQuery(where)
      .params.filter(
        (v): v is string => typeof v === 'string' && /^\d{4}-\d{2}$/.test(v),
      );
  let locks = 0;
  const db: Partial<DrizzleDB> = {
    query: {
      orders: { findMany: () => Promise.resolve(orderRows) },
      paymentLinks: { findMany: () => Promise.resolve([]) },
      settlements: {
        findMany: () => Promise.resolve(paidRows),
        findFirst: ({ where }: { where: SQL }) =>
          Promise.resolve(
            paidRows.find((p) => p.period === periodsOf(where)[0]),
          ),
      },
    } as never,
    select: ((fields: Record<string, unknown>) => ({
      from: (table: unknown) => {
        if ('id' in fields)
          return {
            where: () => ({
              for: () => {
                locks++;
                return Promise.resolve([{ id: 's' }]);
              },
            }),
          };
        if (table === paymentMethods)
          return Promise.resolve([...catalog.values()]);
        return {
          where: () =>
            Promise.resolve([
              { cents: payments.reduce((sum, p) => sum + p.amountCents, 0) },
            ]),
        };
      },
    })) as never,
    insert: ((table: unknown) => ({
      values: (input: unknown) => {
        if (table === serviceFeePayments) {
          payments.push(input as Payment);
          return Promise.resolve();
        }
        const value = input as Paid;
        return {
          onConflictDoNothing: () => {
            if (!paidRows.some((p) => p.period === value.period))
              paidRows.push(value);
            return Promise.resolve();
          },
          onConflictDoUpdate: () => {
            const i = paidRows.findIndex((p) => p.period === value.period);
            if (i < 0) paidRows.push(value);
            else paidRows[i] = value;
            return Promise.resolve();
          },
        };
      },
    })) as never,
    delete: ((table: unknown) => ({
      where: (where: SQL) => {
        const [period] = periodsOf(where);
        if (table === settlements) {
          const keep = paidRows.filter(
            (p) => p.period !== period && p.paidWithPeriod !== period,
          );
          paidRows.splice(0, paidRows.length, ...keep);
        } else {
          const keep = payments.filter((p) => p.payoutPeriod !== period);
          payments.splice(0, payments.length, ...keep);
        }
        return Promise.resolve();
      },
    })) as never,
    transaction: (async (work: (tx: DrizzleDB) => Promise<unknown>) => {
      const saved = { paid: [...paidRows], payments: [...payments] };
      try {
        return await work(db as DrizzleDB);
      } catch (error) {
        paidRows.splice(0, paidRows.length, ...saved.paid);
        payments.splice(0, payments.length, ...saved.payments);
        throw error;
      }
    }) as never,
  };
  const service = new SettlementsService(
    db as DrizzleDB,
    { requireById: () => Promise.resolve(shop) } as never,
    { byCode: () => Promise.resolve(catalog) } as never,
  );

  return {
    service,
    paidRows,
    payments,
    orderRows,
    delivered,
    locks: () => locks,
  };
}

describe('recording combined transfers', () => {
  beforeAll(() => jest.useFakeTimers().setSystemTime(at));
  afterAll(() => jest.useRealTimers());
  const proof = {
    data: 'data:application/pdf;base64,AAAA',
    name: 'transfer.pdf',
  };
  it('records the actual net transfer and offsets the debt once across carried cycles', async () => {
    const h = harness();
    const row = await h.service.decide('s', '2026-12', true, undefined, proof);
    expect(h.locks()).toBe(1);
    expect(h.payments.map((p) => p.amountCents)).toEqual([45_000]);
    expect(h.paidRows).toHaveLength(2);
    expect(h.paidRows.every((p) => p.paidWithPeriod === '2026-12')).toBe(true);
    expect(
      h.paidRows.reduce(
        (sum, p) => sum + p.payoutCents - p.duesDeductedCents,
        0,
      ),
    ).toBe(432_500);
    expect(
      h.paidRows.reduce((sum, p) => sum + (p.proofs?.[0]?.payoutCents ?? 0), 0),
    ).toBe(432_500);
    expect(row.transfer).toBe(4325);
    expect(row.carried).toBe(955);
    expect(row.duesDeducted).toBe(450);
    await h.service.decide('s', '2026-12', true, undefined, proof);
    expect(h.payments).toHaveLength(1);
    expect(
      h.paidRows.reduce((sum, p) => sum + (p.proofs?.length ?? 0), 0),
    ).toBe(2);
  });
  it('undoes every carried cycle and its matching offset atomically', async () => {
    const h = harness();
    await h.service.decide('s', '2026-12', true, undefined, proof);
    await expect(h.service.decide('s', '2026-11', false)).rejects.toThrow(
      /combined transfer/,
    );
    expect(h.paidRows).toHaveLength(2);
    await h.service.decide('s', '2026-12', false);
    expect(h.paidRows).toHaveLength(0);
    expect(h.payments).toHaveLength(0);
  });
  it('uses only newly arrived earnings when topping up a paid cycle', async () => {
    const h = harness();
    await h.service.decide('s', '2026-12', true, undefined, proof);
    h.orderRows.push(h.delivered('late', '2026-11-29', 300_000));
    h.orderRows.push(
      h.delivered('new-debt', '2026-11-29', 1_000_000, 'cod', 450),
    );
    await h.service.decide('s', '2026-12', true, undefined, proof);
    expect(h.payments.reduce((sum, p) => sum + p.amountCents, 0)).toBe(90_000);
    const current = h.paidRows.find((p) => p.period === '2026-12')!;
    expect(current.proofs!.map((p) => p.payoutCents)).toEqual([
      382_000, 241_500,
    ]);
    expect(current.duesDeductedCents).toBe(45_000);
  });
  it('holds a positive net transfer under 2,000 even when gross earnings exceed it', async () => {
    const h = harness();
    h.orderRows.splice(
      0,
      h.orderRows.length,
      h.delivered('online', '2026-11-20', 250_000),
      h.delivered('cash', '2026-11-21', 1_000_000, 'cod', 450),
    );
    await expect(
      h.service.decide('s', '2026-12', true, undefined, proof),
    ).rejects.toThrow(/minimum/);
    expect(h.paidRows).toHaveLength(0);
    expect(h.payments).toHaveLength(0);
  });
});
