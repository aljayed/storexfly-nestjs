import {
  ORDER_DEADLINES,
  orderDeadline,
  withinSellerEditWindow,
} from './order-deadlines';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const now = Date.now();
const ago = (ms: number) => new Date(now - ms);

/** A live order, overridden per case. */
const order = (over: Partial<Parameters<typeof orderDeadline>[0]> = {}) => ({
  status: 'New' as const,
  pay: 'Due' as const,
  placedAt: ago(0),
  confirmedAt: null,
  handedOverAt: null,
  ...over,
});

describe('orderDeadline', () => {
  it('puts a new order on the confirm clock', () => {
    const due = orderDeadline(order({ placedAt: ago(HOUR) }));
    expect(due?.kind).toBe('confirm');
    expect(due?.reason).toBe('auto_unconfirmed');
    // 72h from placement, not from now.
    expect(due!.dueAt.getTime()).toBe(
      now - HOUR + ORDER_DEADLINES.confirmHours * HOUR,
    );
  });

  it('moves to the dispatch clock once confirmed', () => {
    const due = orderDeadline(
      order({ status: 'Confirmed', placedAt: ago(4 * DAY), confirmedAt: ago(DAY) }),
    );
    expect(due?.kind).toBe('dispatch');
    expect(due?.reason).toBe('auto_undispatched');
  });

  it('keeps the dispatch clock running through Packed', () => {
    expect(
      orderDeadline(
        order({ status: 'Packed', placedAt: ago(2 * DAY), confirmedAt: ago(DAY) }),
      )?.kind,
    ).toBe('dispatch');
  });

  it('stops the dispatch clock at handover', () => {
    const due = orderDeadline(
      order({
        status: 'Packed',
        placedAt: ago(2 * DAY),
        confirmedAt: ago(DAY),
        handedOverAt: ago(HOUR),
      }),
    );
    expect(due?.kind).toBe('deliver');
  });

  it('leaves an order confirmed before the column on the 30-day clock alone', () => {
    // No confirmedAt: a legacy row must not be back-dated into an instant
    // cancellation the first time the sweep sees it.
    const due = orderDeadline(
      order({ status: 'Confirmed', placedAt: ago(DAY), confirmedAt: null }),
    );
    expect(due?.kind).toBe('deliver');
    expect(due!.dueAt.getTime()).toBeGreaterThan(now);
  });

  it('takes whichever clock runs out first', () => {
    // Confirmed yesterday (dispatch due in 6 days) but placed 29 days ago,
    // so the 30-day limit lands first.
    const due = orderDeadline(
      order({ status: 'Confirmed', placedAt: ago(29 * DAY), confirmedAt: ago(DAY) }),
    );
    expect(due?.kind).toBe('deliver');
  });

  it('runs no clock on a finished order', () => {
    for (const status of ['Delivered', 'Cancelled', 'Exchanged'] as const) {
      expect(orderDeadline(order({ status, placedAt: ago(90 * DAY) }))).toBeNull();
    }
  });

  it('leaves an in-flight gateway payment to the payments sweep', () => {
    expect(orderDeadline(order({ pay: 'Pending', placedAt: ago(5 * DAY) }))).toBeNull();
  });

  it('reports overdue orders as already past due', () => {
    const due = orderDeadline(order({ placedAt: ago(4 * DAY) }));
    expect(due!.dueAt.getTime()).toBeLessThan(now);
  });
});

describe('withinSellerEditWindow', () => {
  it('is open inside the window and shut outside it', () => {
    expect(withinSellerEditWindow(ago(14 * DAY))).toBe(true);
    expect(withinSellerEditWindow(ago(16 * DAY))).toBe(false);
  });
});
