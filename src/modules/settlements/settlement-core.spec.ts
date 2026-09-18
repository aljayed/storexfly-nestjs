import {
  currentPeriod,
  monthRange,
  periodOf,
  previousPeriod,
  windowOf,
} from './settlement-core';

/**
 * Which month a sale is paid out in is the seller's month, not the server's.
 * Production runs in UTC and the shops are in Dhaka (UTC+6), so a sale made
 * in the small hours of the 1st used to settle with the month before it.
 */
describe('settlement calendar', () => {
  it('puts an after-midnight sale in the month the seller made it', () => {
    // 1 Sep 02:00 in Dhaka is still 31 August in UTC.
    expect(periodOf(new Date('2026-08-31T20:00:00.000Z'))).toBe('2026-09');
    // 31 Aug 23:00 Dhaka is 1 September in UTC.
    expect(periodOf(new Date('2026-08-31T17:00:00.000Z'))).toBe('2026-08');
  });

  it('spans a month from midnight to midnight in the shop’s zone', () => {
    const [from, end] = monthRange('2026-09');
    expect(from.toISOString()).toBe('2026-08-31T18:00:00.000Z');
    expect(end.toISOString()).toBe('2026-09-30T18:00:00.000Z');
    const earlyFirst = new Date('2026-08-31T20:00:00.000Z');
    expect(earlyFirst >= from && earlyFirst < end).toBe(true);
  });

  it('steps back over a year boundary', () => {
    expect(previousPeriod('2026-01')).toBe('2025-12');
    expect(previousPeriod('2026-09')).toBe('2026-08');
  });

  it('pays out in the month after the earnings month', () => {
    expect(windowOf('2026-09')).toEqual({
      from: '2026-10-15',
      to: '2026-10-21',
    });
    expect(windowOf('2026-12')).toEqual({
      from: '2027-01-15',
      to: '2027-01-21',
    });
  });

  it('reports the current period on the seller’s calendar', () => {
    expect(currentPeriod()).toBe(periodOf(new Date()));
  });
});
