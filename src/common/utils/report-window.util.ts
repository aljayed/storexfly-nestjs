/**
 * Shared reporting-window maths. Every report on the seller console resolves
 * its range the same way, so the dashboard, the insights report and the
 * retention report can never disagree about what "last 30 days" means.
 *
 * Date-only bounds ("2026-05-01") are inclusive calendar dates in server-local
 * time; bounds carrying a time part ("2026-05-01T14:00:00Z", used by the
 * "last 24 hours" preset) are exact instants with `to` exclusive.
 */

export type Granularity = 'hour' | 'day' | 'month';

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
      : startOfDay(new Date(fromIso))
    : fallbackFrom(now);

  let toInclusive: Date;
  let end: Date;
  if (toIso && hasTimePart(toIso)) {
    end = new Date(toIso);
    toInclusive = end;
  } else {
    toInclusive = toIso ? startOfDay(new Date(toIso)) : startOfDay(now);
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
        label: `${String(cursor.getHours()).padStart(2, '0')}:00`,
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
        label: `${cursor.getDate()} ${MONTH_LABELS[cursor.getMonth()]}`,
        from: cursor,
        to: addDays(cursor, 1),
      });
    }
    return buckets;
  }
  for (
    let cursor = new Date(win.from.getFullYear(), win.from.getMonth(), 1);
    cursor < win.end && buckets.length < 36;
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)
  ) {
    buckets.push({
      label: MONTH_LABELS[cursor.getMonth()],
      from: cursor,
      to: new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1),
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

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function startOfHour(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours());
}

export function addHours(d: Date, hours: number): Date {
  return new Date(d.getTime() + hours * 3_600_000);
}

export function addDays(d: Date, days: number): Date {
  const next = new Date(d);
  next.setDate(next.getDate() + days);
  return next;
}

/** Local calendar date as "YYYY-MM-DD" (not UTC - buckets are local days). */
export function isoDate(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Percentage of `total`, one decimal place. 0 when there is no denominator. */
export function pctOf(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 1000) / 10 : 0;
}

/** Period-over-period change as a percentage, one decimal place. */
export function pctChange(current: number, previous: number): number {
  if (previous > 0) return Math.round(((current - previous) / previous) * 1000) / 10;
  return current > 0 ? 100 : 0;
}
