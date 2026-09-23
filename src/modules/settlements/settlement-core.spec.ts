import {
  currentPeriod,
  monthRange,
  periodOf,
  previousPeriod,
  settledOnOf,
  windowOf,
} from './settlement-core';

/**
 * A payout follows the goods, not the sale: what a shop is paid between the
 * 15th and the 21st is everything that reached a buyer before the 15th, and
 * a parcel that arrives on the 15th waits for the next month's payout.
 *
 * Which side of the line a delivery falls on is read on the seller's
 * calendar, not the server's. Production runs in UTC and the shops are in
 * Dhaka (UTC+6), so a parcel delivered at 1am on the 15th is the 15th here
 * even though it is still the 14th in UTC.
 */
describe('the payout cycle', () => {
  it('pays a delivery made before the 15th in that month', () => {
    expect(periodOf(new Date('2026-09-14T10:00:00.000Z'))).toBe('2026-09');
    expect(periodOf(new Date('2026-09-01T10:00:00.000Z'))).toBe('2026-09');
  });

  it('holds a delivery made on or after the 15th for the next month', () => {
    expect(periodOf(new Date('2026-09-15T04:00:00.000Z'))).toBe('2026-10');
    expect(periodOf(new Date('2026-09-30T10:00:00.000Z'))).toBe('2026-10');
  });

  it('reads the cut-off on the seller’s calendar', () => {
    // 15 Sep 01:00 in Dhaka is still 14 September in UTC - and it has missed
    // the cut-off, because the shop's day has turned.
    expect(periodOf(new Date('2026-09-14T19:00:00.000Z'))).toBe('2026-10');
    // 14 Sep 23:00 Dhaka is 14 September at home: it is in.
    expect(periodOf(new Date('2026-09-14T17:00:00.000Z'))).toBe('2026-09');
  });

  it('runs a cycle from the 15th to the 15th', () => {
    const [from, end] = monthRange('2026-09');
    // Midnight on the 15th in Dhaka is 6pm the day before in UTC.
    expect(from.toISOString()).toBe('2026-08-14T18:00:00.000Z');
    expect(end.toISOString()).toBe('2026-09-14T18:00:00.000Z');
    const justInside = new Date('2026-09-14T17:00:00.000Z');
    expect(justInside >= from && justInside < end).toBe(true);
  });

  it('pays out between the 15th and the 21st of the cycle’s own month', () => {
    expect(windowOf('2026-09')).toEqual({ from: '2026-09-15', to: '2026-09-21' });
    expect(windowOf('2027-01')).toEqual({ from: '2027-01-15', to: '2027-01-21' });
  });

  it('carries a late-December delivery into January’s payout', () => {
    expect(periodOf(new Date('2026-12-20T10:00:00.000Z'))).toBe('2027-01');
    const [from, end] = monthRange('2027-01');
    expect(from.toISOString()).toBe('2026-12-14T18:00:00.000Z');
    expect(end.toISOString()).toBe('2027-01-14T18:00:00.000Z');
    expect(previousPeriod('2027-01')).toBe('2026-12');
  });

  it('reports the cycle now collecting deliveries', () => {
    expect(currentPeriod()).toBe(periodOf(new Date()));
  });
});

describe('when an order becomes payable', () => {
  const at = new Date('2026-09-10T10:00:00.000Z');
  const earlier = new Date('2026-09-02T10:00:00.000Z');

  it('follows the courier’s delivery stamp', () => {
    expect(
      settledOnOf({ deliveredAt: at, handedOverAt: earlier, deliveryMode: 'carrybee' }),
    ).toBe(at);
  });

  // Nobody reports a delivery a shop arranged itself, so the handover is the
  // last thing the platform can see of the parcel.
  it('falls back to the handover when the shop delivers itself', () => {
    expect(
      settledOnOf({ deliveredAt: null, handedOverAt: at, deliveryMode: 'manual' }),
    ).toBe(at);
  });

  it('is nothing at all until the parcel has gone', () => {
    expect(
      settledOnOf({ deliveredAt: null, handedOverAt: at, deliveryMode: 'carrybee' }),
    ).toBeNull();
    expect(
      settledOnOf({ deliveredAt: null, handedOverAt: null, deliveryMode: 'manual' }),
    ).toBeNull();
  });
});
