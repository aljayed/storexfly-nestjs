import {
  addDays,
  buildBuckets,
  calendarDate,
  isoDate,
  REPORT_TIME_ZONE,
  resolveWindow,
  startOfDay,
  startOfMonth,
  zonedParts,
} from './report-window.util';

/**
 * Reports are read on the seller's calendar, not the server's.
 *
 * Production runs in UTC while the shops are in Dhaka (UTC+6), so these all
 * pin the boundary that used to slip: an order taken at 5am in Dhaka belongs
 * to that morning, not to the day before.
 */
describe('report window', () => {
  const dhaka = (iso: string) => new Date(iso);

  it('defaults to the market the console serves', () => {
    expect(REPORT_TIME_ZONE).toBe('Asia/Dhaka');
  });

  it('starts the day at midnight in the shop’s zone, not the server’s', () => {
    // 18 Sep 05:22 in Dhaka is still 17 Sep in UTC.
    const earlyMorning = dhaka('2026-09-17T23:22:23.845Z');
    expect(startOfDay(earlyMorning).toISOString()).toBe(
      '2026-09-17T18:00:00.000Z',
    );
    expect(earlyMorning >= startOfDay(earlyMorning)).toBe(true);
    expect(isoDate(earlyMorning)).toBe('2026-09-18');
  });

  it('keeps a late-evening order on the day the seller had it', () => {
    // 23:30 Dhaka is already the next day in UTC.
    const lateEvening = dhaka('2026-09-18T17:30:00.000Z');
    expect(isoDate(lateEvening)).toBe('2026-09-18');
    expect(startOfDay(lateEvening).toISOString()).toBe(
      '2026-09-17T18:00:00.000Z',
    );
  });

  it('reads a date-only bound as that calendar day in the shop’s zone', () => {
    expect(calendarDate('2026-09-18').toISOString()).toBe(
      '2026-09-17T18:00:00.000Z',
    );
    const win = resolveWindow('2026-09-18', '2026-09-18', (now) => now);
    expect(win.from.toISOString()).toBe('2026-09-17T18:00:00.000Z');
    expect(win.end.toISOString()).toBe('2026-09-18T18:00:00.000Z');
    expect(win.spanDays).toBe(1);
    // The 5:22am order sits inside the day the seller would call "today".
    const order = dhaka('2026-09-17T23:22:23.845Z');
    expect(order >= win.from && order < win.end).toBe(true);
  });

  it('leaves exact instants alone, so "last 24 hours" is still 24 hours', () => {
    const win = resolveWindow(
      '2026-09-17T05:00:00.000Z',
      '2026-09-18T05:00:00.000Z',
      (now) => now,
    );
    expect(win.from.toISOString()).toBe('2026-09-17T05:00:00.000Z');
    expect(win.end.toISOString()).toBe('2026-09-18T05:00:00.000Z');
    expect(win.granularity).toBe('hour');
  });

  it('adds days and months on the seller’s calendar', () => {
    const day = startOfDay(dhaka('2026-09-17T23:22:00.000Z'));
    expect(isoDate(addDays(day, 1))).toBe('2026-09-19');
    expect(isoDate(addDays(day, -29))).toBe('2026-08-20');
    expect(startOfMonth(dhaka('2026-09-17T23:22:00.000Z')).toISOString()).toBe(
      '2026-08-31T18:00:00.000Z',
    );
    // 30 Sep 20:00 UTC is already 1 October in Dhaka, so the 12-month
    // dashboard window starts in November - the server's month would be off.
    expect(isoDate(startOfMonth(dhaka('2026-09-30T20:00:00.000Z'), -11))).toBe(
      '2025-11-01',
    );
  });

  it('labels buckets with the hour and day the seller saw', () => {
    const win = resolveWindow('2026-09-16', '2026-09-18', (now) => now);
    const days = buildBuckets(win);
    expect(days.map((b) => b.label)).toEqual(['16 Sep', '17 Sep', '18 Sep']);
    // Each day bucket covers midnight to midnight in Dhaka.
    expect(days[0].from.toISOString()).toBe('2026-09-15T18:00:00.000Z');

    const hours = buildBuckets(
      resolveWindow(
        '2026-09-17T23:00:00.000Z',
        '2026-09-18T01:00:00.000Z',
        (now) => now,
      ),
    );
    expect(hours.map((b) => b.label)).toEqual(['05:00', '06:00']);
  });

  it('reads the wall clock in the shop’s zone', () => {
    expect(zonedParts(dhaka('2026-09-17T23:22:23.845Z'))).toEqual({
      year: 2026,
      month: 9,
      day: 18,
      hour: 5,
      minute: 22,
      second: 23,
    });
  });
});
