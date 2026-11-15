import {
  currentPeriod,
  monthRange,
  periodOf,
  previousPeriod,
  settledOnOf,
  windowOf,
} from './settlement-core';

/**
 * A payout follows the goods, not the sale: what a shop is paid in the first
 * week of a month is everything that reached a buyer in the month before.
 *
 * Which month a delivery falls in is read on the seller's calendar, not the
 * server's. Production runs in UTC and the shops are in Dhaka (UTC+6), so a
 * parcel delivered at 1am on the 1st is the 1st here even though it is still
 * the last day of the month before in UTC.
 */
describe('the payout cycle', () => {
  it('pays a delivery in the first week of the month after', () => {
    expect(periodOf(new Date('2027-01-01T10:00:00.000Z'))).toBe('2027-02');
    expect(periodOf(new Date('2027-01-31T10:00:00.000Z'))).toBe('2027-02');
    expect(windowOf('2027-02')).toEqual({
      from: '2027-02-01',
      to: '2027-02-07',
    });
  });

  it('reads the month on the seller’s calendar', () => {
    // 1 Feb 01:00 in Dhaka is still 31 January in UTC - but the shop's month
    // has turned, so it is February's delivery.
    expect(periodOf(new Date('2027-01-31T19:00:00.000Z'))).toBe('2027-03');
    // 31 Jan 23:00 Dhaka is January at home.
    expect(periodOf(new Date('2027-01-31T17:00:00.000Z'))).toBe('2027-02');
  });

  it('runs a cycle over the calendar month before the one it is named for', () => {
    const [from, end] = monthRange('2027-02');
    // Midnight on the 1st in Dhaka is 6pm the day before in UTC.
    expect(from.toISOString()).toBe('2026-12-31T18:00:00.000Z');
    expect(end.toISOString()).toBe('2027-01-31T18:00:00.000Z');
  });

  it('carries a December delivery into January’s payout', () => {
    expect(periodOf(new Date('2026-12-20T10:00:00.000Z'))).toBe('2027-01');
    expect(previousPeriod('2027-01')).toBe('2026-12');
  });

  it('reports the cycle now collecting deliveries', () => {
    expect(currentPeriod()).toBe(periodOf(new Date()));
  });
});

/**
 * Cycles that closed while payouts ran mid-month keep that rule. Their
 * payouts were recorded against those dates; reading them on the new rule
 * would move delivered orders out of a paid cycle and into an unpaid one,
 * and the shop would be paid for them twice.
 */
describe('cycles from before payouts moved to the 1st', () => {
  it('still splits a month at the 15th', () => {
    expect(periodOf(new Date('2026-09-14T10:00:00.000Z'))).toBe('2026-09');
    expect(periodOf(new Date('2026-09-15T04:00:00.000Z'))).toBe('2026-10');
    // On the seller's calendar, as it always was.
    expect(periodOf(new Date('2026-09-14T19:00:00.000Z'))).toBe('2026-10');
  });

  it('still runs from the 15th to the 15th, paid 15th-21st', () => {
    const [from, end] = monthRange('2026-09');
    expect(from.toISOString()).toBe('2026-08-14T18:00:00.000Z');
    expect(end.toISOString()).toBe('2026-09-14T18:00:00.000Z');
    expect(windowOf('2026-09')).toEqual({
      from: '2026-09-15',
      to: '2026-09-21',
    });
  });

  it('closes the last mid-month cycle on 15 November', () => {
    expect(periodOf(new Date('2026-11-14T10:00:00.000Z'))).toBe('2026-11');
    expect(monthRange('2026-11')[1].toISOString()).toBe(
      '2026-11-14T18:00:00.000Z',
    );
  });

  it('bridges the rest of November into the first payout by the 7th', () => {
    expect(periodOf(new Date('2026-11-15T04:00:00.000Z'))).toBe('2026-12');
    expect(periodOf(new Date('2026-11-30T10:00:00.000Z'))).toBe('2026-12');
    const [from, end] = monthRange('2026-12');
    expect(from.toISOString()).toBe('2026-11-14T18:00:00.000Z');
    expect(end.toISOString()).toBe('2026-11-30T18:00:00.000Z');
    expect(windowOf('2026-12')).toEqual({
      from: '2026-12-01',
      to: '2026-12-07',
    });
  });

  it('leaves no delivery in two cycles, and none in neither', () => {
    // Every instant belongs to exactly the cycle whose range contains it.
    for (const iso of [
      '2026-10-14T17:59:59.000Z',
      '2026-10-14T18:00:00.000Z',
      '2026-11-14T17:59:59.000Z',
      '2026-11-14T18:00:00.000Z',
      '2026-11-30T17:59:59.000Z',
      '2026-11-30T18:00:00.000Z',
      '2026-12-31T18:00:00.000Z',
    ]) {
      const at = new Date(iso);
      const [from, end] = monthRange(periodOf(at));
      expect(at >= from && at < end).toBe(true);
    }
  });
});

describe('when an order becomes payable', () => {
  const at = new Date('2026-09-10T10:00:00.000Z');
  const earlier = new Date('2026-09-02T10:00:00.000Z');

  it('follows the courier’s delivery stamp', () => {
    expect(
      settledOnOf({
        deliveredAt: at,
        handedOverAt: earlier,
        deliveryMode: 'carrybee',
      }),
    ).toBe(at);
  });

  // Nobody reports a delivery a shop arranged itself, so the handover is the
  // last thing the platform can see of the parcel.
  it('falls back to the handover when the shop delivers itself', () => {
    expect(
      settledOnOf({
        deliveredAt: null,
        handedOverAt: at,
        deliveryMode: 'manual',
      }),
    ).toBe(at);
  });

  it('is nothing at all until the parcel has gone', () => {
    expect(
      settledOnOf({
        deliveredAt: null,
        handedOverAt: at,
        deliveryMode: 'carrybee',
      }),
    ).toBeNull();
    expect(
      settledOnOf({
        deliveredAt: null,
        handedOverAt: null,
        deliveryMode: 'manual',
      }),
    ).toBeNull();
  });
});
