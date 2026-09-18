/**
 * Shared reporting-window maths. Every report on the seller console resolves
 * its range the same way, so the dashboard, the insights report and the
 * retention report can never disagree about what "last 30 days" means.
 *
 * Date-only bounds ("2026-05-01") are inclusive calendar dates in the shop's
 * calendar (see `REPORT_TIME_ZONE`); bounds carrying a time part
 * ("2026-05-01T14:00:00Z", used by the "last 24 hours" preset) are exact
 * instants with `to` exclusive.
 *
 * ## Why days are not the server's days
 *
 * Production runs in UTC, so "today" used to begin at 6am in Dhaka: an order
 * taken at 5am counted towards yesterday, and the dashboard could show "৳0
 * today" while the last-24-hours tile showed the sale. A report is read on the
 * seller's calendar, so every day, month and bucket boundary here is resolved
 * in `REPORT_TIME_ZONE` rather than in whatever zone the process happens to
 * run in. Set REPORTS_TIMEZONE to move the whole console to another market.
 */

export type Granularity = 'hour' | 'day' | 'month';

/** The calendar every report is read on. Same default as the rest of the app. */
export const REPORT_TIME_ZONE =
  process.env.REPORTS_TIMEZONE?.trim() || 'Asia/Dhaka';

const ZONE_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: REPORT_TIME_ZONE,
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

export interface ZonedParts {
  year: number;
  /** 1-12, as people write months. */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** An instant as the wall clock reads it in the report timezone. */
export function zonedParts(at: Date): ZonedParts {
  const found: Record<string, number> = {};
  for (const part of ZONE_PARTS.formatToParts(at)) {
    if (part.type !== 'literal') found[part.type] = Number(part.value);
  }
  return {
    year: found.year,
    month: found.month,
    day: found.day,
    // Midnight comes back as 24 from some ICU builds.
    hour: found.hour % 24,
    minute: found.minute,
    second: found.second,
  };
}

/** How far ahead of UTC the zone is at that instant, in milliseconds. */
function zoneOffsetMs(at: Date): number {
  const p = zonedParts(at);
  const asUtc = Date.UTC(
    p.year,
    p.month - 1,
    p.day,
    p.hour,
    p.minute,
    p.second,
  );
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * The instant a wall-clock time in the report timezone happens. Month and day
 * overflow the way `Date.UTC` allows, so callers can add to either.
 *
 * The offset is applied twice on purpose: the first guess uses the offset at
 * the wrong instant, which is only visible across a DST change (not in Dhaka,
 * but this utility is the one place another market would go through).
 */
export function zonedTime(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  const first = new Date(wall - zoneOffsetMs(new Date(wall)));
  return new Date(wall - zoneOffsetMs(first));
}

/** Midnight that begins the calendar month `delta` months from `at`. */
export function startOfMonth(at: Date, delta = 0): Date {
  const p = zonedParts(at);
  return zonedTime(p.year, p.month + delta, 1);
}

export interface ReportWindow {
  /** Inclusive start of the selected window. */
  from: Date;
  /** Exclusive end of the selected window. */
  end: Date;
  /** Last instant the UI should label as "to" (inclusive). */
  toInclusive: Date;
  /** Inclusive start of the preceding window of identical length. */
  prevFrom: Date;
  /** Length of the window in whole days (rounded). */
  spanDays: number;
  granularity: Granularity;
}

export const MONTH_LABELS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/**
 * Resolve a [from, to] pair into a window plus the preceding window of equal
 * length. `fallbackFrom` decides the default when no bounds are given
 * (the dashboard defaults to 12 calendar months, other reports to 30 days).
 */
export function resolveWindow(
  fromIso: string | undefined,
  toIso: string | undefined,
  fallbackFrom: (now: Date) => Date,
  now = new Date(),
): ReportWindow {
  const from = fromIso
    ? hasTimePart(fromIso)
      ? new Date(fromIso)
      : calendarDate(fromIso)
    : fallbackFrom(now);

  let toInclusive: Date;
  let end: Date;
  if (toIso && hasTimePart(toIso)) {
    end = new Date(toIso);
    toInclusive = end;
  } else {
    toInclusive = toIso ? calendarDate(toIso) : startOfDay(now);
    end = addDays(toInclusive, 1);
  }

  const spanMs = Math.max(end.getTime() - from.getTime(), 1);
  const spanDays = Math.round(spanMs / 86_400_000);
  return {
    from,
    end,
    toInclusive,
    prevFrom: new Date(from.getTime() - spanMs),
    spanDays,
    // Hour buckets up to 2 days, day buckets up to ~2 months, else months.
    granularity:
      spanMs <= 48 * 3_600_000 ? 'hour' : spanDays <= 62 ? 'day' : 'month',
  };
}

/**
 * The buckets a series should be drawn with. Each carries the instant it
 * covers so the client can label a range rather than guess from one edge.
 */
export interface SeriesBucket {
  label: string;
  from: Date;
  to: Date;
}

export function buildBuckets(win: ReportWindow): SeriesBucket[] {
  const buckets: SeriesBucket[] = [];
  if (win.granularity === 'hour') {
    for (
      let cursor = startOfHour(win.from);
      cursor < win.end && buckets.length < 48;
      cursor = addHours(cursor, 1)
    ) {
      buckets.push({
        label: `${String(zonedParts(cursor).hour).padStart(2, '0')}:00`,
        from: cursor,
        to: addHours(cursor, 1),
      });
    }
    return buckets;
  }
  if (win.granularity === 'day') {
    for (
      let cursor = startOfDay(win.from);
      cursor < win.end && buckets.length < 70;
      cursor = addDays(cursor, 1)
    ) {
      buckets.push({
        label: `${zonedParts(cursor).day} ${MONTH_LABELS[zonedParts(cursor).month - 1]}`,
        from: cursor,
        to: addDays(cursor, 1),
      });
    }
    return buckets;
  }
  for (
    let cursor = startOfMonth(win.from);
    cursor < win.end && buckets.length < 36;
    cursor = startOfMonth(cursor, 1)
  ) {
    buckets.push({
      label: MONTH_LABELS[zonedParts(cursor).month - 1],
      from: cursor,
      to: startOfMonth(cursor, 1),
    });
  }
  return buckets;
}

/**
 * Bucket index for a timestamp, or -1 when it falls outside the series. Buckets
 * are contiguous and ordered, so a binary search keeps this O(log n) even for
 * the 70-day series.
 */
export function bucketIndex(buckets: SeriesBucket[], at: Date): number {
  let lo = 0;
  let hi = buckets.length - 1;
  const t = at.getTime();
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (t < buckets[mid].from.getTime()) hi = mid - 1;
    else if (t >= buckets[mid].to.getTime()) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/** Whether an ISO-8601 string carries a time component (vs date-only). */
export function hasTimePart(iso: string): boolean {
  return iso.includes('T');
}

/** A date-only bound ("2026-05-01") as midnight in the report timezone. */
export function calendarDate(iso: string): Date {
  const [year, month, day] = iso.slice(0, 10).split('-').map(Number);
  return Number.isFinite(year) && Number.isFinite(month) && Number.isFinite(day)
    ? zonedTime(year, month, day)
    : startOfDay(new Date(iso));
}

export function startOfDay(d: Date): Date {
  const p = zonedParts(d);
  return zonedTime(p.year, p.month, p.day);
}

export function startOfHour(d: Date): Date {
  const p = zonedParts(d);
  return zonedTime(p.year, p.month, p.day, p.hour);
}

export function addHours(d: Date, hours: number): Date {
  return new Date(d.getTime() + hours * 3_600_000);
}

/** Calendar-day arithmetic in the report timezone, keeping the wall clock. */
export function addDays(d: Date, days: number): Date {
  const p = zonedParts(d);
  return zonedTime(p.year, p.month, p.day + days, p.hour, p.minute, p.second);
}

/** Calendar date as "YYYY-MM-DD", on the seller's calendar. */
export function isoDate(d: Date): string {
  const p = zonedParts(d);
  const m = String(p.month).padStart(2, '0');
  const day = String(p.day).padStart(2, '0');
  return `${p.year}-${m}-${day}`;
}

/** Percentage of `total`, one decimal place. 0 when there is no denominator. */
export function pctOf(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 1000) / 10 : 0;
}

/** Period-over-period change as a percentage, one decimal place. */
export function pctChange(current: number, previous: number): number {
  if (previous > 0)
    return Math.round(((current - previous) / previous) * 1000) / 10;
  return current > 0 ? 100 : 0;
}
