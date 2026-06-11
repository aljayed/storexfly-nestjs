import { Inject, Injectable } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { centsToDollars } from '../../common/utils/money.util';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import { customers, orders } from '../../database/schema';
import { CustomerResponse } from '../customers/dto/customer.response';
import { ShopsService } from '../shops/shops.service';
import type {
  DashboardResponse,
  RevenuePointResponse,
} from './dto/dashboard.response';
import type { RepeatBuyersResponse } from './dto/repeat-buyers.response';

const MONTH_LABELS = [
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

@Injectable()
export class ReportsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly shops: ShopsService,
  ) {}

  /**
   * KPIs + revenue series for the admin dashboard, scoped to an optional
   * [from, to] window (inclusive calendar dates, default: last 12 months).
   * Also reports the preceding window of equal length for real deltas.
   */
  async dashboard(
    shopId: string,
    fromIso?: string,
    toIso?: string,
  ): Promise<DashboardResponse> {
    await this.shops.requireById(shopId);
    const rows = await this.db.query.orders.findMany({
      where: eq(orders.shopId, shopId),
      columns: {
        totalCents: true,
        qty: true,
        pay: true,
        placedAt: true,
      },
    });
    const paid = rows.filter((r) => r.pay === 'Paid');

    const now = new Date();
    const startOfToday = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    );

    // Resolve the window. `to` is inclusive → compare against the next day.
    const from = fromIso
      ? startOfDay(new Date(fromIso))
      : new Date(now.getFullYear(), now.getMonth() - 11, 1);
    const toInclusive = toIso ? startOfDay(new Date(toIso)) : startOfToday;
    const end = addDays(toInclusive, 1);
    // The preceding window of identical length, for period-over-period deltas.
    const spanMs = end.getTime() - from.getTime();
    const prevFrom = new Date(from.getTime() - spanMs);

    let revenueTodayCents = 0;
    let ordersToday = 0;
    let revenueCents = 0;
    let ordersInRange = 0;
    let unitsSold = 0;
    let prevRevenueCents = 0;
    let prevOrders = 0;

    for (const r of paid) {
      if (r.placedAt >= startOfToday) {
        revenueTodayCents += r.totalCents;
        ordersToday += 1;
      }
      if (r.placedAt >= from && r.placedAt < end) {
        revenueCents += r.totalCents;
        ordersInRange += 1;
        unitsSold += r.qty;
      } else if (r.placedAt >= prevFrom && r.placedAt < from) {
        prevRevenueCents += r.totalCents;
        prevOrders += 1;
      }
    }

    const inRange = paid.filter((r) => r.placedAt >= from && r.placedAt < end);
    // Day buckets for short windows, month buckets beyond ~2 months.
    const spanDays = Math.round(spanMs / 86_400_000);
    const granularity: 'day' | 'month' = spanDays <= 62 ? 'day' : 'month';

    return {
      revenueToday: centsToDollars(revenueTodayCents),
      ordersToday,
      repeatBuyerRate: await this.computeRepeatRate(shopId),
      rangeFrom: isoDate(from),
      rangeTo: isoDate(toInclusive),
      revenue: centsToDollars(revenueCents),
      orders: ordersInRange,
      unitsSold,
      avgOrderValue:
        ordersInRange > 0
          ? centsToDollars(Math.round(revenueCents / ordersInRange))
          : 0,
      prevRevenue: centsToDollars(prevRevenueCents),
      prevOrders,
      granularity,
      revenueSeries:
        granularity === 'day'
          ? this.buildDailySeries(inRange, from, end)
          : this.buildMonthlySeries(inRange, from, end),
    };
  }

  /** Repeat-buyer report — customers with more than one lifetime order. */
  async repeatBuyers(shopId: string): Promise<RepeatBuyersResponse> {
    await this.shops.requireById(shopId);
    const all = await this.db.query.customers.findMany({
      where: eq(customers.shopId, shopId),
    });
    const repeat = await this.db.query.customers.findMany({
      where: eq(customers.shopId, shopId),
      orderBy: [desc(customers.ordersCount)],
    });
    const repeatBuyers = repeat.filter((c) => c.ordersCount > 1);

    const totalCustomers = all.length;
    const repeatCustomers = repeatBuyers.length;
    const repeatRate =
      totalCustomers > 0
        ? Math.round((repeatCustomers / totalCustomers) * 1000) / 10
        : 0;
    const avgOrders =
      repeatCustomers > 0
        ? Math.round(
            (repeatBuyers.reduce((sum, c) => sum + c.ordersCount, 0) /
              repeatCustomers) *
              10,
          ) / 10
        : 0;

    return {
      totalCustomers,
      repeatCustomers,
      repeatRate,
      avgOrdersPerRepeatBuyer: avgOrders,
      buyers: repeatBuyers.map(CustomerResponse.fromRow),
    };
  }

  /** Orders CSV for the dashboard "Export" button. */
  async exportOrdersCsv(shopId: string): Promise<string> {
    await this.shops.requireById(shopId);
    const rows = await this.db.query.orders.findMany({
      where: eq(orders.shopId, shopId),
      orderBy: [desc(orders.placedAt)],
    });
    const header = [
      'reference',
      'date',
      'customer',
      'email',
      'qty',
      'total',
      'status',
      'payment',
      'channel',
    ];
    const lines = rows.map((o) =>
      [
        o.reference,
        o.placedAt.toISOString(),
        csvCell(o.customerName),
        csvCell(o.email),
        String(o.qty),
        centsToDollars(o.totalCents).toFixed(2),
        o.status,
        o.pay,
        o.channel,
      ].join(','),
    );
    return [header.join(','), ...lines].join('\n');
  }

  private async computeRepeatRate(shopId: string): Promise<number> {
    const all = await this.db
      .select({ ordersCount: customers.ordersCount })
      .from(customers)
      .where(eq(customers.shopId, shopId));
    if (all.length === 0) return 0;
    const repeat = all.filter((c) => c.ordersCount > 1).length;
    return Math.round((repeat / all.length) * 1000) / 10;
  }

  /** One bucket per calendar month between `from` (inclusive) and `end`. */
  private buildMonthlySeries(
    rows: { totalCents: number; placedAt: Date }[],
    from: Date,
    end: Date,
  ): RevenuePointResponse[] {
    const buckets: { label: string; key: string; cents: number }[] = [];
    const cursor = new Date(from.getFullYear(), from.getMonth(), 1);
    while (cursor < end && buckets.length < 36) {
      buckets.push({
        label: MONTH_LABELS[cursor.getMonth()],
        key: `${cursor.getFullYear()}-${cursor.getMonth()}`,
        cents: 0,
      });
      cursor.setMonth(cursor.getMonth() + 1);
    }
    const index = new Map(buckets.map((b) => [b.key, b]));
    for (const r of rows) {
      const key = `${r.placedAt.getFullYear()}-${r.placedAt.getMonth()}`;
      const bucket = index.get(key);
      if (bucket) bucket.cents += r.totalCents;
    }
    return buckets.map((b) => ({
      label: b.label,
      value: centsToDollars(b.cents),
    }));
  }

  /** One bucket per day between `from` (inclusive) and `end` (exclusive). */
  private buildDailySeries(
    rows: { totalCents: number; placedAt: Date }[],
    from: Date,
    end: Date,
  ): RevenuePointResponse[] {
    const buckets: { label: string; key: string; cents: number }[] = [];
    for (
      let cursor = new Date(from);
      cursor < end && buckets.length < 70;
      cursor = addDays(cursor, 1)
    ) {
      buckets.push({
        label: `${cursor.getDate()} ${MONTH_LABELS[cursor.getMonth()]}`,
        key: isoDate(cursor),
        cents: 0,
      });
    }
    const index = new Map(buckets.map((b) => [b.key, b]));
    for (const r of rows) {
      const bucket = index.get(isoDate(r.placedAt));
      if (bucket) bucket.cents += r.totalCents;
    }
    return buckets.map((b) => ({
      label: b.label,
      value: centsToDollars(b.cents),
    }));
  }
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d: Date, days: number): Date {
  const next = new Date(d);
  next.setDate(next.getDate() + days);
  return next;
}

/** Local calendar date as "YYYY-MM-DD" (not UTC — buckets are local days). */
function isoDate(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Escapes a CSV cell (quotes/commas/newlines). */
function csvCell(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
