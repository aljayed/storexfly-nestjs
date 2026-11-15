import {
  allocate,
  orderDue,
  payByOf,
  sellerCollectedCents,
  standingOf,
  type FeeOrder,
  type MethodCatalog,
} from './service-fee-core';

const catalog: MethodCatalog = new Map([
  ['cod', { gateway: 'none' as const }],
  ['direct', { gateway: 'none' as const }],
  ['bkash', { gateway: 'bkash' as const }],
]);

const order = (patch: Partial<FeeOrder>): FeeOrder => ({
  id: 'o1',
  totalCents: 100_000,
  advanceCents: 0,
  paymentMethod: 'cod',
  platformFeeBp: 450,
  resellerShopId: null,
  resellerMarginCents: 0,
  duesPaidAt: null,
  ...patch,
});

describe('what an order leaves the seller owing', () => {
  it('charges 4.5% of a cash-on-delivery sale', () => {
    expect(orderDue(order({}), catalog)).toEqual({
      collectedCents: 100_000,
      feeCents: 4_500,
      marginCents: 0,
      dueCents: 4_500,
    });
  });

  it('owes nothing on an order paid online - the payout carries that fee', () => {
    expect(orderDue(order({ paymentMethod: 'bkash' }), catalog).dueCents).toBe(
      0,
    );
  });

  it('owes nothing on an order recorded by hand', () => {
    expect(orderDue(order({ paymentMethod: null }), catalog).dueCents).toBe(0);
  });

  it('charges only the door-collected balance of a protected COD order', () => {
    const o = order({ paymentMethod: 'bkash', advanceCents: 15_000 });
    expect(sellerCollectedCents(o, catalog)).toBe(85_000);
    expect(orderDue(o, catalog).feeCents).toBe(3_825);
  });

  it('charges a direct transfer like cash - the seller holds it either way', () => {
    expect(orderDue(order({ paymentMethod: 'direct' }), catalog).dueCents).toBe(
      4_500,
    );
  });

  it('adds the whole reseller margin, and charges the fee on the rest', () => {
    const due = orderDue(
      order({ resellerShopId: 'r1', resellerMarginCents: 20_000 }),
      catalog,
    );
    expect(due.marginCents).toBe(20_000);
    expect(due.feeCents).toBe(3_600); // 4.5% of the supplier's 800
    expect(due.dueCents).toBe(23_600);
  });

  it('owes nothing on an order from before the fee existed', () => {
    expect(orderDue(order({ platformFeeBp: 0 }), catalog).dueCents).toBe(0);
  });
});

describe('matching payments to orders', () => {
  const rows = [
    { id: 'a', dueCents: 1_000, paid: false },
    { id: 'b', dueCents: 2_000, paid: false },
    { id: 'c', dueCents: 500, paid: false },
  ];

  it('covers the oldest orders first', () => {
    expect(allocate(rows, 3_000)).toEqual({
      cover: ['a', 'b'],
      uncover: [],
      balanceCents: 500,
    });
  });

  it('never skips an older order to reach a smaller one', () => {
    expect(allocate(rows, 1_600).cover).toEqual(['a']);
  });

  it('keeps an overpayment as credit', () => {
    expect(allocate(rows, 5_000).balanceCents).toBe(-1_500);
  });

  it('takes a stamp back when the payments no longer reach it', () => {
    const stamped = rows.map((r) => ({ ...r, paid: true }));
    expect(allocate(stamped, 1_000).uncover).toEqual(['b', 'c']);
  });
});

describe('where a balance stands', () => {
  const now = new Date('2026-11-15T00:00:00Z');
  const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);

  it('has no deadline at or under the limit', () => {
    expect(standingOf(200_000, null, false, now)).toBe('open');
  });

  it('is due for three days once over the limit', () => {
    expect(standingOf(200_001, daysAgo(2), false, now)).toBe('due');
    expect(payByOf(daysAgo(2)).getTime()).toBe(now.getTime() + 86_400_000);
  });

  it('is overdue after the three days', () => {
    expect(standingOf(200_001, daysAgo(4), false, now)).toBe('overdue');
  });

  it('stays overdue while suspended, until the balance is gone', () => {
    expect(standingOf(100, null, true, now)).toBe('overdue');
    expect(standingOf(0, null, true, now)).toBe('clear');
  });
});
