import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  and,
  count,
  countDistinct,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNotNull,
  lt,
  max,
  ne,
  or,
  sql,
  sum,
} from 'drizzle-orm';
import { centsToDollars } from '../../common/utils/money.util';
import { productLines } from '../../common/utils/order-line.util';
import { DRIZZLE } from '../../database/database.constants';
import type { DbExecutor, DrizzleDB } from '../../database/drizzle.types';
import { customers, orders, type CustomerRow } from '../../database/schema';
import type { CustomerSegment } from '../../database/schema/enums';
import { OrderResponse } from '../orders/dto/order.response';
import { CustomerListResponse } from './dto/customer-list.response';
import { CustomerResponse } from './dto/customer.response';
import type { ActivitySort } from './dto/monthly-activity-query.dto';
import type {
  ActivityCellResponse,
  ActivityMonthResponse,
  ActivityMonthTotalsResponse,
  CustomerActivityRowResponse,
  MonthlyActivityResponse,
} from './dto/monthly-activity.response';

export interface RecordOrderInput {
  shopId: string;
  name: string;
  email: string;
  phone?: string;
  city?: string;
  amountCents: number;
  placedAt: Date;
}

/** Segment thresholds (derived server-side - never trusted from the client). */
const VIP_MIN_ORDERS = 20;
const REPEAT_MIN_ORDERS = 2;

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

/** Local calendar month bucket key, "YYYY-MM" (same convention as reports). */
function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

@Injectable()
export class CustomersService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  /** Lifetime-aggregate driven segmentation (order count only). */
  static computeSegment(ordersCount: number): CustomerSegment {
    if (ordersCount >= VIP_MIN_ORDERS) {
      return 'VIP';
    }
    if (ordersCount >= REPEAT_MIN_ORDERS) {
      return 'Repeat';
    }
    return 'New';
  }

  /**
   * Find-or-create a customer for an incoming order and roll the lifetime
   * aggregates forward. Runs against whichever executor is passed so it can
   * participate in the checkout transaction. Returns the customer id.
   */
  async recordOrder(tx: DbExecutor, input: RecordOrderInput): Promise<string> {
    const email = input.email.toLowerCase();
    const existing = await tx.query.customers.findFirst({
      where: and(
        eq(customers.shopId, input.shopId),
        eq(customers.email, email),
      ),
    });

    if (!existing) {
      const segment = CustomersService.computeSegment(1);
      const [row] = await tx
        .insert(customers)
        .values({
          shopId: input.shopId,
          name: input.name,
          email,
          phone: input.phone ?? '',
          city: input.city ?? '',
          ordersCount: 1,
          spentCents: input.amountCents,
          firstOrderAt: input.placedAt,
          lastOrderAt: input.placedAt,
          segment,
        })
        .returning({ id: customers.id });
      return row.id;
    }

    const ordersCount = existing.ordersCount + 1;
    const spentCents = existing.spentCents + input.amountCents;
    const lastOrderAt =
      !existing.lastOrderAt || input.placedAt > existing.lastOrderAt
        ? input.placedAt
        : existing.lastOrderAt;
    const firstOrderAt =
      !existing.firstOrderAt || input.placedAt < existing.firstOrderAt
        ? input.placedAt
        : existing.firstOrderAt;

    await tx
      .update(customers)
      .set({
        name: input.name || existing.name,
        phone: input.phone || existing.phone,
        city: input.city || existing.city,
        ordersCount,
        spentCents,
        lastOrderAt,
        firstOrderAt,
        segment: CustomersService.computeSegment(ordersCount),
      })
      .where(eq(customers.id, existing.id));
    return existing.id;
  }

  /** Adjusts aggregates when an order is refunded (decrements spend). */
  async applyRefund(
    tx: DbExecutor,
    customerId: string,
    amountCents: number,
  ): Promise<void> {
    const customer = await tx.query.customers.findFirst({
      where: eq(customers.id, customerId),
    });
    if (!customer) return;
    const spentCents = Math.max(0, customer.spentCents - amountCents);
    // Segment is order-count driven, so a refund (spend-only) can't change it.
    await tx
      .update(customers)
      .set({ spentCents })
      .where(eq(customers.id, customerId));
  }

  /**
   * Re-syncs a customer's lifetime spend when an order's total changes (a
   * buyer-approved amount adjustment). Signed delta: positive adds, negative
   * removes. The order count is unchanged, so the segment can't move.
   */
  async adjustSpend(
    tx: DbExecutor,
    customerId: string,
    deltaCents: number,
  ): Promise<void> {
    if (!deltaCents) return;
    const customer = await tx.query.customers.findFirst({
      where: eq(customers.id, customerId),
    });
    if (!customer) return;
    const spentCents = Math.max(0, customer.spentCents + deltaCents);
    await tx
      .update(customers)
      .set({ spentCents })
      .where(eq(customers.id, customerId));
  }

  /**
   * Reverses a whole order from a customer's aggregates when it is cancelled
   * (unlike `applyRefund`, which only unwinds spend, a cancellation also drops
   * the order count since the sale never happened).
   */
  async unwindOrder(
    tx: DbExecutor,
    customerId: string,
    amountCents: number,
  ): Promise<void> {
    const customer = await tx.query.customers.findFirst({
      where: eq(customers.id, customerId),
    });
    if (!customer) return;
    const ordersCount = Math.max(0, customer.ordersCount - 1);
    const spentCents = Math.max(0, customer.spentCents - amountCents);
    await tx
      .update(customers)
      .set({
        ordersCount,
        spentCents,
        segment: CustomersService.computeSegment(ordersCount),
      })
      .where(eq(customers.id, customerId));
  }

  /**
   * Paginated admin list. `total` counts the filtered set; `stats` are
   * shop-wide aggregates so the header KPIs and segment tab counts stay
   * correct regardless of the active page or filter.
   */
  async list(
    shopId: string,
    query: {
      segment?: CustomerSegment;
      q?: string;
      page: number;
      limit: number;
      offset: number;
    },
  ): Promise<CustomerListResponse> {
    const conditions = [eq(customers.shopId, shopId)];
    if (query.segment) conditions.push(eq(customers.segment, query.segment));
    const q = query.q?.trim();
    if (q) {
      const like = `%${q}%`;
      conditions.push(
        or(
          ilike(customers.name, like),
          ilike(customers.email, like),
          ilike(customers.phone, like),
          ilike(customers.city, like),
        )!,
      );
    }
    const where = and(...conditions);

    const [rows, [{ total }], segmentRows, [aggr]] = await Promise.all([
      this.db.query.customers.findMany({
        where,
        orderBy: [desc(customers.spentCents)],
        limit: query.limit,
        offset: query.offset,
      }),
      this.db.select({ total: count() }).from(customers).where(where),
      this.db
        .select({ segment: customers.segment, n: count() })
        .from(customers)
        .where(eq(customers.shopId, shopId))
        .groupBy(customers.segment),
      this.db
        .select({
          returning: sql<string>`count(*) filter (where ${customers.ordersCount} > 1)`,
          avgSpentCents: sql<string>`coalesce(avg(${customers.spentCents}), 0)`,
        })
        .from(customers)
        .where(eq(customers.shopId, shopId)),
    ]);

    const counts: Record<string, number> = { All: 0 };
    for (const r of segmentRows) {
      counts[r.segment] = r.n;
      counts.All += r.n;
    }

    return {
      data: rows.map(CustomerResponse.fromRow),
      total,
      page: query.page,
      limit: query.limit,
      stats: {
        counts,
        returning: Number(aggr.returning),
        avgLifetime: Math.round(Number(aggr.avgSpentCents)) / 100,
      },
    };
  }

  /** Decision-oriented repeat-buyer report. A repeat buyer has at least two
   * non-cancelled orders inside the selected window; the comparison uses the
   * immediately preceding window of the same length. */
  async repeatAnalytics(shopId: string, days: number) {
    const end = new Date();
    const start = new Date(end.getTime() - days * 86_400_000);
    const previousStart = new Date(start.getTime() - days * 86_400_000);
    const rows = await this.db.query.orders.findMany({
      where: and(
        eq(orders.shopId, shopId),
        isNotNull(orders.customerId),
        ne(orders.status, 'Cancelled'),
        gte(orders.placedAt, previousStart),
        lt(orders.placedAt, end),
      ),
      columns: { customerId: true, totalCents: true, placedAt: true },
      with: { items: { columns: { productId: true, name: true, qty: true, unitPriceCents: true } } },
      orderBy: [desc(orders.placedAt)],
    });
    const current = rows.filter((o) => o.placedAt >= start);
    const previous = rows.filter((o) => o.placedAt < start);

    type BuyerAcc = { orders: number; revenueCents: number; dates: Date[] };
    const group = (source: typeof rows) => {
      const buyers = new Map<string, BuyerAcc>();
      for (const o of source) {
        if (!o.customerId) continue;
        const acc = buyers.get(o.customerId) ?? { orders: 0, revenueCents: 0, dates: [] };
        acc.orders += 1;
        acc.revenueCents += o.totalCents;
        acc.dates.push(o.placedAt);
        buyers.set(o.customerId, acc);
      }
      const repeat = [...buyers.values()].filter((b) => b.orders >= 2);
      const revenueCents = source.reduce((n, o) => n + o.totalCents, 0);
      const repeatRevenueCents = repeat.reduce((n, b) => n + b.revenueCents, 0);
      return { buyers, repeat, revenueCents, repeatRevenueCents };
    };
    const cur = group(current);
    const prev = group(previous);
    const pct = (a: number, b: number) => b ? Math.round(((a - b) / b) * 1000) / 10 : a ? 100 : 0;
    const repeatOrders = cur.repeat.reduce((n, b) => n + b.orders, 0);
    const gaps: number[] = [];
    for (const b of cur.repeat) {
      const dates = [...b.dates].sort((a, z) => a.getTime() - z.getTime());
      for (let i = 1; i < dates.length; i++) gaps.push((dates[i].getTime() - dates[i - 1].getTime()) / 86_400_000);
    }

    const ids = [...cur.buyers.keys()];
    const customerRows = ids.length
      ? await this.db.query.customers.findMany({ where: inArray(customers.id, ids) })
      : [];
    const byId = new Map(customerRows.map((c) => [c.id, c]));
    const topCustomers = [...cur.buyers]
      .filter(([, b]) => b.orders >= 2)
      .sort((a, b) => b[1].revenueCents - a[1].revenueCents)
      .slice(0, 50)
      .map(([id, b]) => ({
        customer: byId.has(id) ? CustomerResponse.fromRow(byId.get(id)!) : null,
        windowOrders: b.orders,
        windowSpent: centsToDollars(b.revenueCents),
        averageOrder: centsToDollars(Math.round(b.revenueCents / b.orders)),
        lastOrder: new Date(Math.max(...b.dates.map((d) => d.getTime()))).toISOString(),
      }))
      .filter((r) => r.customer);

    const bucketCount = days <= 7 ? 7 : days <= 30 ? 10 : days <= 180 ? 6 : 12;
    const bucketMs = (days * 86_400_000) / bucketCount;
    const trend = Array.from({ length: bucketCount }, (_, i) => {
      const from = new Date(start.getTime() + i * bucketMs);
      const to = new Date(start.getTime() + (i + 1) * bucketMs);
      const bucket = group(current.filter((o) => o.placedAt >= from && o.placedAt < to));
      return {
        from: from.toISOString(), to: to.toISOString(),
        buyers: bucket.buyers.size, repeatBuyers: bucket.repeat.length,
        orders: current.filter((o) => o.placedAt >= from && o.placedAt < to).length,
        revenue: centsToDollars(bucket.revenueCents),
      };
    });

    const newBuyers = customerRows.filter((c) => c.firstOrderAt && c.firstOrderAt >= start).length;

    // Product ranking deliberately measures both volume and repeat pull. A
    // product with many units sold once is different from one that brings the
    // same customers back across multiple orders.
    type ProductAcc = {
      name: string; units: number; revenueCents: number; orders: Set<string>;
      buyerOrders: Map<string, Set<string>>; lastOrdered: Date;
    };
    const productMap = new Map<string, ProductAcc>();
    current.forEach((o, orderIndex) => {
      if (!o.customerId) return;
      for (const item of o.items) {
        const orderKey = `${orderIndex}`;
        const key = item.productId ?? `name:${item.name.trim().toLocaleLowerCase()}`;
        const p = productMap.get(key) ?? {
          name: item.name, units: 0, revenueCents: 0, orders: new Set<string>(),
          buyerOrders: new Map<string, Set<string>>(), lastOrdered: o.placedAt,
        };
        p.units += item.qty;
        p.revenueCents += item.qty * item.unitPriceCents;
        p.orders.add(orderKey);
        const buyerOrders = p.buyerOrders.get(o.customerId) ?? new Set<string>();
        buyerOrders.add(orderKey);
        p.buyerOrders.set(o.customerId, buyerOrders);
        if (o.placedAt > p.lastOrdered) p.lastOrdered = o.placedAt;
        productMap.set(key, p);
      }
    });
    const topProducts = [...productMap.values()].map((p) => {
      const repeatBuyers = [...p.buyerOrders.values()].filter((buyerOrders) => buyerOrders.size >= 2).length;
      const buyers = p.buyerOrders.size;
      return {
        name: p.name,
        units: p.units, orders: p.orders.size, buyers, repeatBuyers,
        repeatRate: buyers ? Math.round((repeatBuyers / buyers) * 1000) / 10 : 0,
        revenue: centsToDollars(p.revenueCents),
        averageUnitsPerOrder: p.orders.size ? Math.round((p.units / p.orders.size) * 10) / 10 : 0,
        lastOrdered: p.lastOrdered.toISOString(),
      };
    }).sort((a, b) => b.repeatBuyers - a.repeatBuyers || b.orders - a.orders || b.units - a.units);

    return {
      days, start: start.toISOString(), end: end.toISOString(),
      metrics: {
        buyers: cur.buyers.size,
        repeatBuyers: cur.repeat.length,
        repeatRate: cur.buyers.size ? Math.round((cur.repeat.length / cur.buyers.size) * 1000) / 10 : 0,
        repeatRevenue: centsToDollars(cur.repeatRevenueCents),
        repeatRevenueShare: cur.revenueCents ? Math.round((cur.repeatRevenueCents / cur.revenueCents) * 1000) / 10 : 0,
        repeatOrders,
        orderFrequency: cur.repeat.length ? Math.round((repeatOrders / cur.repeat.length) * 10) / 10 : 0,
        averageRepeatOrder: repeatOrders ? centsToDollars(Math.round(cur.repeatRevenueCents / repeatOrders)) : 0,
        averageDaysBetween: gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : 0,
        newBuyers,
      },
      changes: {
        repeatBuyers: pct(cur.repeat.length, prev.repeat.length),
        repeatRate: pct(cur.buyers.size ? cur.repeat.length / cur.buyers.size : 0, prev.buyers.size ? prev.repeat.length / prev.buyers.size : 0),
        repeatRevenue: pct(cur.repeatRevenueCents, prev.repeatRevenueCents),
      },
      trend, topCustomers, topProducts,
    };
  }

  /**
   * Month-wise activity matrix: one row per customer who ordered inside the
   * window (default: last 12 calendar months), one sparse cell per month with
   * the order count, spend, and the product names bought. Pagination and sort
   * run in SQL over the window aggregates; the page's cells are bucketed here
   * so month boundaries match the reports module (server-local time).
   */
  async monthlyActivity(
    shopId: string,
    query: {
      segment?: CustomerSegment;
      q?: string;
      months: number;
      sort: ActivitySort;
      page: number;
      limit: number;
      offset: number;
    },
  ): Promise<MonthlyActivityResponse> {
    const now = new Date();
    const windowStart = new Date(
      now.getFullYear(),
      now.getMonth() - (query.months - 1),
      1,
    );

    const months: ActivityMonthResponse[] = [];
    for (let i = 0; i < query.months; i++) {
      const d = new Date(
        windowStart.getFullYear(),
        windowStart.getMonth() + i,
        1,
      );
      months.push({
        key: monthKey(d),
        label: MONTH_LABELS[d.getMonth()],
        year: d.getFullYear(),
      });
    }

    const conditions = [
      eq(orders.shopId, shopId),
      isNotNull(orders.customerId),
      gte(orders.placedAt, windowStart),
    ];
    if (query.segment) conditions.push(eq(customers.segment, query.segment));
    const q = query.q?.trim();
    if (q) {
      const like = `%${q}%`;
      conditions.push(
        or(
          ilike(customers.name, like),
          ilike(customers.email, like),
          ilike(customers.phone, like),
          ilike(customers.city, like),
        )!,
      );
    }
    const where = and(...conditions);

    const windowOrders = count(orders.id);
    const windowSpentCents = sum(orders.totalCents);
    const orderBy =
      query.sort === 'spent'
        ? [desc(windowSpentCents), desc(windowOrders)]
        : query.sort === 'recent'
          ? [desc(max(orders.placedAt)), desc(windowOrders)]
          : [desc(windowOrders), desc(windowSpentCents)];

    const [pageRows, [{ total }], allWindow] = await Promise.all([
      this.db
        .select({
          customerId: orders.customerId,
          windowOrders,
          windowSpentCents,
        })
        .from(orders)
        .innerJoin(customers, eq(orders.customerId, customers.id))
        .where(where)
        .groupBy(orders.customerId)
        .orderBy(...orderBy)
        .limit(query.limit)
        .offset(query.offset),
      this.db
        .select({ total: countDistinct(orders.customerId) })
        .from(orders)
        .innerJoin(customers, eq(orders.customerId, customers.id))
        .where(where),
      // Shop-wide (unfiltered) window orders for the per-month footer totals.
      this.db.query.orders.findMany({
        where: and(
          eq(orders.shopId, shopId),
          gte(orders.placedAt, windowStart),
        ),
        columns: { customerId: true, totalCents: true, placedAt: true },
      }),
    ]);

    const ids = pageRows.map((r) => r.customerId!);
    const [customerRows, pageOrders] = ids.length
      ? await Promise.all([
          this.db.query.customers.findMany({
            where: inArray(customers.id, ids),
          }),
          this.db.query.orders.findMany({
            where: and(
              eq(orders.shopId, shopId),
              gte(orders.placedAt, windowStart),
              inArray(orders.customerId, ids),
            ),
            columns: { customerId: true, totalCents: true, placedAt: true },
            with: {
              items: { columns: { name: true, qty: true, productId: true } },
            },
          }),
        ])
      : [[], []];

    // Bucket the page's orders into customer × month cells.
    type CellAcc = {
      orders: number;
      spentCents: number;
      products: Map<string, number>;
    };
    const cellsByCustomer = new Map<string, Map<string, CellAcc>>();
    for (const o of pageOrders) {
      if (!o.customerId) continue;
      const key = monthKey(o.placedAt);
      let byMonth = cellsByCustomer.get(o.customerId);
      if (!byMonth) cellsByCustomer.set(o.customerId, (byMonth = new Map()));
      let cell = byMonth.get(key);
      if (!cell) {
        byMonth.set(
          key,
          (cell = { orders: 0, spentCents: 0, products: new Map() }),
        );
      }
      cell.orders += 1;
      cell.spentCents += o.totalCents;
      for (const it of productLines(o.items)) {
        cell.products.set(it.name, (cell.products.get(it.name) ?? 0) + it.qty);
      }
    }

    // Rows in the SQL sort order (the page query is the source of truth).
    const rowsById = new Map(customerRows.map((c) => [c.id, c]));
    const data: CustomerActivityRowResponse[] = [];
    for (const r of pageRows) {
      const row = rowsById.get(r.customerId!);
      if (!row) continue;
      const cells: Record<string, ActivityCellResponse> = {};
      for (const [key, cell] of cellsByCustomer.get(row.id) ?? []) {
        cells[key] = {
          orders: cell.orders,
          spent: centsToDollars(cell.spentCents),
          products: [...cell.products]
            .map(([name, qty]) => ({ name, qty }))
            .sort((a, b) => b.qty - a.qty),
        };
      }
      data.push({
        customer: CustomerResponse.fromRow(row),
        windowOrders: Number(r.windowOrders),
        windowSpent: centsToDollars(Number(r.windowSpentCents ?? 0)),
        activeMonths: Object.keys(cells).length,
        cells,
      });
    }

    const totalsAcc = new Map<
      string,
      { customers: Set<string>; orders: number; revenueCents: number }
    >(
      months.map((m) => [
        m.key,
        { customers: new Set(), orders: 0, revenueCents: 0 },
      ]),
    );
    for (const o of allWindow) {
      const t = totalsAcc.get(monthKey(o.placedAt));
      if (!t) continue;
      t.orders += 1;
      t.revenueCents += o.totalCents;
      if (o.customerId) t.customers.add(o.customerId);
    }
    const totals: Record<string, ActivityMonthTotalsResponse> = {};
    for (const [key, t] of totalsAcc) {
      totals[key] = {
        customers: t.customers.size,
        orders: t.orders,
        revenue: centsToDollars(t.revenueCents),
      };
    }

    return {
      months,
      data,
      totals,
      total: Number(total),
      page: query.page,
      limit: query.limit,
    };
  }

  async getWithHistory(
    shopId: string,
    id: string,
  ): Promise<CustomerResponse & { history: OrderResponse[] }> {
    const customer = await this.requireOwned(shopId, id);
    const history = await this.db.query.orders.findMany({
      where: eq(orders.customerId, id),
      orderBy: [desc(orders.placedAt)],
      with: { items: true },
    });
    return {
      ...CustomerResponse.fromRow(customer),
      history: history.map((o) => OrderResponse.fromRow(o, o.items)),
    };
  }

  private async requireOwned(shopId: string, id: string): Promise<CustomerRow> {
    const customer = await this.db.query.customers.findFirst({
      where: and(eq(customers.id, id), eq(customers.shopId, shopId)),
    });
    if (!customer) {
      throw new NotFoundException('Customer not found in this shop');
    }
    return customer;
  }
}
