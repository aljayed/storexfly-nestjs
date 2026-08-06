import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, lt, ne } from 'drizzle-orm';
import { centsToDollars } from '../../common/utils/money.util';
import { productLines } from '../../common/utils/order-line.util';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import {
  customers,
  orders,
  paymentMethods,
  type OrderRow,
} from '../../database/schema';
import type { OrderStatus } from '../../database/schema/enums';
import { ShopsService } from '../shops/shops.service';
import type {
  DashboardResponse,
  RevenuePointResponse,
} from './dto/dashboard.response';
import type {
  AreaSplitResponse,
  ChannelSplitResponse,
  DiscountInsightResponse,
  FulfilmentInsightResponse,
  FunnelStageResponse,
  InsightsResponse,
  PaymentSplitResponse,
  PipelineStageResponse,
  ProductInsightResponse,
  ProductsInsightResponse,
  SalesInsightResponse,
} from './dto/insights.response';
import {
  buildBuckets,
  bucketIndex,
  isoDate,
  pctOf,
  resolveWindow,
  startOfDay,
  type ReportWindow,
} from '../../common/utils/report-window.util';

/**
 * The fulfilment pipeline is strictly linear (see STATUS_FLOW in the orders
 * service), so a status doubles as "how far this order got". Ranking it lets
 * every stage of the funnel be answered with one comparison. `Cancelled` is
 * off the ladder - an order that never completed did not reach any stage.
 */
const STAGE_RANK: Record<OrderStatus, number> = {
  New: 0,
  Confirmed: 1,
  Packed: 2,
  HandedOver: 3,
  Shipped: 4,
  Delivered: 5,
  Cancelled: -1,
};

/** Funnel rows, in pipeline order. `New` is the "placed" baseline. */
const FUNNEL_STAGES: { stage: OrderStatus; rank: number }[] = [
  { stage: 'New', rank: 0 },
  { stage: 'Confirmed', rank: 1 },
  { stage: 'Packed', rank: 2 },
  { stage: 'HandedOver', rank: 3 },
  { stage: 'Shipped', rank: 4 },
  { stage: 'Delivered', rank: 5 },
];

/**
 * How long an order should reasonably sit in each open stage before it counts
 * as stuck. These are nudges, not rules - a seller who confirms by phone the
 * same evening is the norm, and a parcel out for a week has gone quiet.
 */
const STAGE_TARGET_DAYS: Record<string, number> = {
  New: 1,
  Confirmed: 2,
  Packed: 2,
  // A parcel the seller says they handed over but the courier hasn't picked
  // up is the one worth chasing soonest - nobody is holding it.
  HandedOver: 1,
  Shipped: 7,
};
const OPEN_STATUSES: OrderStatus[] = [
  'New',
  'Confirmed',
  'Packed',
  'HandedOver',
  'Shipped',
];

/** Products carrying this share of revenue are the ones worth protecting. */
const PARETO_TARGET = 0.8;

/** Columns every insights aggregation reads. */
const INSIGHT_COLUMNS = {
  id: true,
  customerId: true,
  totalCents: true,
  deliveryCents: true,
  discountCents: true,
  couponCode: true,
  qty: true,
  status: true,
  pay: true,
  paymentMethod: true,
  channel: true,
  address: true,
  courierConsignmentId: true,
  placedAt: true,
} as const;

type InsightOrder = Pick<OrderRow, keyof typeof INSIGHT_COLUMNS> & {
  items: { productId: string | null; name: string; qty: number; unitPriceCents: number }[];
};

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
    const win = resolveWindow(
      fromIso,
      toIso,
      (now) => new Date(now.getFullYear(), now.getMonth() - 11, 1),
    );
    const rows = await this.db.query.orders.findMany({
      where: eq(orders.shopId, shopId),
      columns: { totalCents: true, qty: true, pay: true, placedAt: true },
    });
    const paid = rows.filter((r) => r.pay === 'Paid');
    const startOfToday = startOfDay(new Date());

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
      if (r.placedAt >= win.from && r.placedAt < win.end) {
        revenueCents += r.totalCents;
        ordersInRange += 1;
        unitsSold += r.qty;
      } else if (r.placedAt >= win.prevFrom && r.placedAt < win.from) {
        prevRevenueCents += r.totalCents;
        prevOrders += 1;
      }
    }

    const buckets = buildBuckets(win);
    const series = buckets.map((b) => ({ label: b.label, cents: 0 }));
    for (const r of paid) {
      const i = bucketIndex(buckets, r.placedAt);
      if (i >= 0) series[i].cents += r.totalCents;
    }

    return {
      revenueToday: centsToDollars(revenueTodayCents),
      ordersToday,
      repeatBuyerRate: await this.computeRepeatRate(shopId),
      rangeFrom: isoDate(win.from),
      rangeTo: isoDate(win.toInclusive),
      revenue: centsToDollars(revenueCents),
      orders: ordersInRange,
      unitsSold,
      avgOrderValue:
        ordersInRange > 0
          ? centsToDollars(Math.round(revenueCents / ordersInRange))
          : 0,
      prevRevenue: centsToDollars(prevRevenueCents),
      prevOrders,
      granularity: win.granularity,
      revenueSeries: series.map<RevenuePointResponse>((s) => ({
        label: s.label,
        value: centsToDollars(s.cents),
      })),
    };
  }

  /**
   * The full seller insights report for a window: where the money came from,
   * where it leaked out, and what is stuck right now. One order fetch feeds
   * every section, so the tabs can never contradict each other.
   */
  async insights(
    shopId: string,
    fromIso?: string,
    toIso?: string,
  ): Promise<InsightsResponse> {
    await this.shops.requireById(shopId);
    const win = resolveWindow(fromIso, toIso, (now) => {
      const d = startOfDay(now);
      d.setDate(d.getDate() - 29);
      return d;
    });

    // `Pending` is a gateway payment still in flight: hidden from the seller
    // pipeline, auto-expiring, and not a sale. It never enters a report.
    const [rows, methodRows, openRows] = await Promise.all([
      this.db.query.orders.findMany({
        where: and(
          eq(orders.shopId, shopId),
          ne(orders.pay, 'Pending'),
          gte(orders.placedAt, win.prevFrom),
          lt(orders.placedAt, win.end),
        ),
        columns: INSIGHT_COLUMNS,
        with: {
          items: {
            columns: {
              productId: true,
              name: true,
              qty: true,
              unitPriceCents: true,
            },
          },
        },
        orderBy: [desc(orders.placedAt)],
      }),
      this.db
        .select({ code: paymentMethods.code, title: paymentMethods.title })
        .from(paymentMethods),
      // The open pipeline is a live snapshot - what is stuck *now* has
      // nothing to do with the window the seller happens to be looking at.
      this.db.query.orders.findMany({
        where: and(
          eq(orders.shopId, shopId),
          ne(orders.pay, 'Pending'),
          inArray(orders.status, OPEN_STATUSES),
        ),
        columns: { status: true, totalCents: true, placedAt: true },
        orderBy: [asc(orders.placedAt)],
      }),
    ]);

    const current = rows.filter(
      (o) => o.placedAt >= win.from && o.placedAt < win.end,
    ) as InsightOrder[];
    const previous = rows.filter((o) => o.placedAt < win.from) as InsightOrder[];

    const methodTitles = new Map(methodRows.map((m) => [m.code, m.title]));

    return {
      range: {
        from: isoDate(win.from),
        to: isoDate(win.toInclusive),
        prevFrom: isoDate(win.prevFrom),
        prevTo: isoDate(new Date(win.from.getTime() - 86_400_000)),
        days: win.spanDays,
        granularity: win.granularity,
      },
      sales: this.buildSales(current, previous, win),
      fulfilment: this.buildFulfilment(current, previous, openRows),
      payments: this.buildPayments(current, methodTitles),
      channels: this.buildChannels(current),
      discounts: this.buildDiscounts(current),
      areas: this.buildAreas(current),
      products: this.buildProducts(current),
    };
  }

  /** Orders CSV for the "Export" buttons, scoped to an optional window. */
  async exportOrdersCsv(
    shopId: string,
    fromIso?: string,
    toIso?: string,
  ): Promise<string> {
    await this.shops.requireById(shopId);
    const scoped = fromIso || toIso;
    const win = scoped
      ? resolveWindow(fromIso, toIso, (now) => startOfDay(now))
      : null;
    const rows = await this.db.query.orders.findMany({
      where: win
        ? and(
            eq(orders.shopId, shopId),
            gte(orders.placedAt, win.from),
            lt(orders.placedAt, win.end),
          )
        : eq(orders.shopId, shopId),
      orderBy: [desc(orders.placedAt)],
    });

    const header = [
      'reference',
      'date',
      'customer',
      'email',
      'phone',
      'area',
      'qty',
      'subtotal',
      'delivery',
      'discount',
      'coupon',
      'total',
      'status',
      'payment',
      'payment_method',
      'channel',
      'courier',
      'consignment',
    ];
    const lines = rows.map((o) =>
      [
        o.reference,
        o.placedAt.toISOString(),
        csvCell(o.customerName),
        csvCell(o.email),
        csvCell(o.phone ?? ''),
        csvCell(o.address?.area ?? ''),
        String(o.qty),
        centsToDollars(
          o.totalCents - o.deliveryCents + o.discountCents,
        ).toFixed(2),
        centsToDollars(o.deliveryCents).toFixed(2),
        centsToDollars(o.discountCents).toFixed(2),
        csvCell(o.couponCode ?? ''),
        centsToDollars(o.totalCents).toFixed(2),
        o.status,
        o.pay,
        csvCell(o.paymentMethod ?? ''),
        o.channel,
        csvCell(o.courierProvider ?? ''),
        csvCell(o.courierConsignmentId ?? ''),
      ].join(','),
    );
    // A BOM so Excel opens Bengali customer names as UTF-8 rather than mojibake.
    return `﻿${[header.join(','), ...lines].join('\n')}`;
  }

  // ── Section builders ──────────────────────────────────────────

  private buildSales(
    current: InsightOrder[],
    previous: InsightOrder[],
    win: ReportWindow,
  ): SalesInsightResponse {
    const now = this.sumSales(current);
    const before = this.sumSales(previous);

    const buckets = buildBuckets(win);
    const series = buckets.map((b) => ({
      label: b.label,
      from: b.from.toISOString(),
      to: b.to.toISOString(),
      netCents: 0,
      collectedCents: 0,
      orders: 0,
    }));
    for (const o of current) {
      if (o.status === 'Cancelled') continue;
      const i = bucketIndex(buckets, o.placedAt);
      if (i < 0) continue;
      series[i].orders += 1;
      if (o.pay === 'Paid') {
        series[i].collectedCents += o.totalCents;
        series[i].netCents += o.totalCents;
      } else if (o.pay === 'Due') {
        series[i].netCents += o.totalCents;
      }
    }

    return {
      netSales: centsToDollars(now.netCents),
      collected: centsToDollars(now.collectedCents),
      outstanding: centsToDollars(now.outstandingCents),
      cancelled: centsToDollars(now.cancelledCents),
      refunded: centsToDollars(now.refundedCents),
      orders: now.orders,
      cancelledOrders: now.cancelledOrders,
      unitsSold: now.units,
      avgOrderValue: avgCents(now.netCents, now.orders),
      deliveryCharged: centsToDollars(now.deliveryCents),
      discountGiven: centsToDollars(now.discountCents),
      buyers: now.buyers.size,
      prevNetSales: centsToDollars(before.netCents),
      prevCollected: centsToDollars(before.collectedCents),
      prevOrders: before.orders,
      prevAvgOrderValue: avgCents(before.netCents, before.orders),
      series: series.map((s) => ({
        label: s.label,
        from: s.from,
        to: s.to,
        netSales: centsToDollars(s.netCents),
        collected: centsToDollars(s.collectedCents),
        orders: s.orders,
      })),
    };
  }

  /**
   * Money split of one set of orders. A sale only counts once it is still
   * standing: cancelled and refunded orders are tracked as leaks and kept out
   * of `orders`, `units` and therefore out of the average order value - an
   * order that gave its money back should not drag the average down as though
   * it were a small sale.
   */
  private sumSales(source: InsightOrder[]) {
    const acc = {
      netCents: 0,
      collectedCents: 0,
      outstandingCents: 0,
      cancelledCents: 0,
      refundedCents: 0,
      deliveryCents: 0,
      discountCents: 0,
      orders: 0,
      cancelledOrders: 0,
      units: 0,
      buyers: new Set<string>(),
    };
    for (const o of source) {
      if (o.status === 'Cancelled') {
        acc.cancelledCents += o.totalCents;
        acc.cancelledOrders += 1;
        continue;
      }
      if (o.pay === 'Refunded') {
        acc.refundedCents += o.totalCents;
        continue;
      }
      acc.orders += 1;
      acc.units += o.qty;
      acc.deliveryCents += o.deliveryCents;
      acc.discountCents += o.discountCents;
      if (o.customerId) acc.buyers.add(o.customerId);
      if (o.pay === 'Paid') {
        acc.collectedCents += o.totalCents;
        acc.netCents += o.totalCents;
      } else {
        acc.outstandingCents += o.totalCents;
        acc.netCents += o.totalCents;
      }
    }
    return acc;
  }

  private buildFulfilment(
    current: InsightOrder[],
    previous: InsightOrder[],
    open: { status: OrderStatus; totalCents: number; placedAt: Date }[],
  ): FulfilmentInsightResponse {
    const rates = (source: InsightOrder[]) => {
      const placed = source.length;
      let confirmed = 0;
      let delivered = 0;
      let cancelled = 0;
      for (const o of source) {
        const rank = STAGE_RANK[o.status];
        if (rank < 0) cancelled += 1;
        if (rank >= 1) confirmed += 1;
        if (rank >= 4) delivered += 1;
      }
      return {
        confirmRate: pctOf(confirmed, placed),
        deliveryRate: pctOf(delivered, placed),
        cancelRate: pctOf(cancelled, placed),
      };
    };

    // The baseline is every order placed, cancellations included - the whole
    // point of the funnel is to show what fell out along the way.
    const placed = current.length;
    let carried = placed;
    const funnel: FunnelStageResponse[] = FUNNEL_STAGES.map(
      ({ stage, rank }, i) => {
        const reached =
          i === 0 ? current : current.filter((o) => STAGE_RANK[o.status] >= rank);
        const row: FunnelStageResponse = {
          stage,
          orders: reached.length,
          value: centsToDollars(reached.reduce((n, o) => n + o.totalCents, 0)),
          pctOfPlaced: pctOf(reached.length, placed),
          droppedFromPrevious: i === 0 ? 0 : Math.max(0, carried - reached.length),
        };
        carried = reached.length;
        return row;
      },
    );

    const shippable = current.filter((o) => STAGE_RANK[o.status] >= 2);
    const now = Date.now();
    const pipeline: PipelineStageResponse[] = OPEN_STATUSES.map((status) => {
      const stageRows = open.filter((o) => o.status === status);
      const targetDays = STAGE_TARGET_DAYS[status];
      const ageDays = (at: Date) => (now - at.getTime()) / 86_400_000;
      return {
        status,
        orders: stageRows.length,
        value: centsToDollars(stageRows.reduce((n, o) => n + o.totalCents, 0)),
        // `open` is sorted oldest first, so the head is the oldest.
        oldestDays: stageRows.length
          ? Math.floor(ageDays(stageRows[0].placedAt))
          : 0,
        overdue: stageRows.filter((o) => ageDays(o.placedAt) > targetDays).length,
        targetDays,
      };
    });

    const currentRates = rates(current);
    const previousRates = rates(previous);
    return {
      funnel,
      ...currentRates,
      prevConfirmRate: previousRates.confirmRate,
      prevDeliveryRate: previousRates.deliveryRate,
      prevCancelRate: previousRates.cancelRate,
      courierBookedRate: pctOf(
        shippable.filter((o) => !!o.courierConsignmentId).length,
        shippable.length,
      ),
      pipeline,
    };
  }

  private buildPayments(
    current: InsightOrder[],
    titles: Map<string, string>,
  ): PaymentSplitResponse[] {
    type Acc = {
      orders: number;
      netCents: number;
      collectedCents: number;
      outstandingCents: number;
      cancelled: number;
    };
    const byCode = new Map<string, Acc>();
    let totalNetCents = 0;
    for (const o of current) {
      const code = o.paymentMethod ?? '';
      const acc = byCode.get(code) ?? {
        orders: 0,
        netCents: 0,
        collectedCents: 0,
        outstandingCents: 0,
        cancelled: 0,
      };
      if (o.status === 'Cancelled') {
        acc.cancelled += 1;
      } else {
        acc.orders += 1;
        if (o.pay === 'Paid') {
          acc.collectedCents += o.totalCents;
          acc.netCents += o.totalCents;
          totalNetCents += o.totalCents;
        } else if (o.pay === 'Due') {
          acc.outstandingCents += o.totalCents;
          acc.netCents += o.totalCents;
          totalNetCents += o.totalCents;
        }
      }
      byCode.set(code, acc);
    }
    return [...byCode]
      .map(([code, a]) => ({
        code,
        // An order recorded by hand carries no method code; the client
        // localizes the empty label rather than showing a blank row.
        label: titles.get(code) ?? code,
        orders: a.orders,
        netSales: centsToDollars(a.netCents),
        collected: centsToDollars(a.collectedCents),
        outstanding: centsToDollars(a.outstandingCents),
        share: pctOf(a.netCents, totalNetCents),
        cancelRate: pctOf(a.cancelled, a.orders + a.cancelled),
      }))
      .sort((a, b) => b.netSales - a.netSales || b.orders - a.orders);
  }

  private buildChannels(current: InsightOrder[]): ChannelSplitResponse[] {
    const byChannel = new Map<
      string,
      { orders: number; netCents: number; cancelled: number }
    >();
    let totalNetCents = 0;
    for (const o of current) {
      const acc = byChannel.get(o.channel) ?? {
        orders: 0,
        netCents: 0,
        cancelled: 0,
      };
      if (o.status === 'Cancelled') {
        acc.cancelled += 1;
      } else {
        acc.orders += 1;
        if (o.pay === 'Paid' || o.pay === 'Due') {
          acc.netCents += o.totalCents;
          totalNetCents += o.totalCents;
        }
      }
      byChannel.set(o.channel, acc);
    }
    return [...byChannel]
      .map(([channel, a]) => ({
        channel,
        orders: a.orders,
        netSales: centsToDollars(a.netCents),
        avgOrderValue: avgCents(a.netCents, a.orders),
        share: pctOf(a.netCents, totalNetCents),
        cancelRate: pctOf(a.cancelled, a.orders + a.cancelled),
      }))
      .sort((a, b) => b.netSales - a.netSales || b.orders - a.orders);
  }

  /**
   * What discounting actually cost, and whether it bought bigger baskets.
   * `avgFullPriceOrder` is the honest control group: the same window's
   * undiscounted orders. If the discounted average isn't clearly higher, the
   * code is buying orders the shop would have got anyway.
   */
  private buildDiscounts(current: InsightOrder[]): DiscountInsightResponse {
    const live = current.filter(
      (o) => o.status !== 'Cancelled' && (o.pay === 'Paid' || o.pay === 'Due'),
    );
    const discounted = live.filter((o) => o.discountCents > 0);
    const fullPrice = live.filter((o) => o.discountCents === 0);

    const discountCents = discounted.reduce((n, o) => n + o.discountCents, 0);
    const discountedNetCents = discounted.reduce((n, o) => n + o.totalCents, 0);
    const fullPriceNetCents = fullPrice.reduce((n, o) => n + o.totalCents, 0);

    const byCode = new Map<
      string,
      { orders: number; discountCents: number; netCents: number }
    >();
    for (const o of discounted) {
      // A discount with no code came from a combo or a manual adjustment.
      const code = o.couponCode ?? '';
      const acc = byCode.get(code) ?? {
        orders: 0,
        discountCents: 0,
        netCents: 0,
      };
      acc.orders += 1;
      acc.discountCents += o.discountCents;
      acc.netCents += o.totalCents;
      byCode.set(code, acc);
    }

    return {
      discountedOrders: discounted.length,
      discountGiven: centsToDollars(discountCents),
      // Against what those orders would have totalled at full price.
      discountRate: pctOf(discountCents, discountedNetCents + discountCents),
      avgDiscountedOrder: avgCents(discountedNetCents, discounted.length),
      avgFullPriceOrder: avgCents(fullPriceNetCents, fullPrice.length),
      coupons: [...byCode]
        .map(([code, a]) => ({
          code,
          orders: a.orders,
          discount: centsToDollars(a.discountCents),
          netSales: centsToDollars(a.netCents),
          avgOrderValue: avgCents(a.netCents, a.orders),
        }))
        .sort((a, b) => b.discount - a.discount || b.orders - a.orders)
        .slice(0, 12),
    };
  }

  /**
   * Where the parcels go, and where they get refused. Areas are keyed
   * case-insensitively ("Dhanmondi" and "dhanmondi" are one place) but shown
   * with the spelling buyers actually typed.
   */
  private buildAreas(current: InsightOrder[]): AreaSplitResponse[] {
    type Acc = {
      label: string;
      orders: number;
      netCents: number;
      cancelled: number;
    };
    const byArea = new Map<string, Acc>();
    for (const o of current) {
      const area = (o.address?.area ?? '').trim();
      if (!area) continue;
      const key = area.toLocaleLowerCase();
      const acc = byArea.get(key) ?? {
        label: area,
        orders: 0,
        netCents: 0,
        cancelled: 0,
      };
      if (o.status === 'Cancelled') {
        acc.cancelled += 1;
      } else {
        acc.orders += 1;
        if (o.pay === 'Paid' || o.pay === 'Due') acc.netCents += o.totalCents;
      }
      byArea.set(key, acc);
    }
    return [...byArea.values()]
      .map((a) => ({
        area: a.label,
        orders: a.orders,
        netSales: centsToDollars(a.netCents),
        avgOrderValue: avgCents(a.netCents, a.orders),
        cancelRate: pctOf(a.cancelled, a.orders + a.cancelled),
      }))
      .sort((a, b) => b.orders - a.orders || b.netSales - a.netSales)
      .slice(0, 12);
  }

  /**
   * Product performance on three axes that a seller decides differently on:
   * volume (what sells), repeat pull (what brings the same buyer back), and
   * cancel rate (what buyers change their mind about after ordering).
   *
   * Only real product lines count - checkout also writes the delivery fee and
   * the combo reconciliation into `order_items`, and neither is something
   * anybody bought.
   */
  private buildProducts(current: InsightOrder[]): ProductsInsightResponse {
    type Acc = {
      name: string;
      units: number;
      revenueCents: number;
      orders: Set<string>;
      cancelledOrders: Set<string>;
      buyerOrders: Map<string, Set<string>>;
      lastOrdered: Date;
    };
    const byProduct = new Map<string, Acc>();

    for (const o of current) {
      const cancelled = o.status === 'Cancelled';
      for (const item of productLines(o.items)) {
        const key =
          item.productId ?? `name:${item.name.trim().toLocaleLowerCase()}`;
        const p =
          byProduct.get(key) ??
          ({
            name: item.name,
            units: 0,
            revenueCents: 0,
            orders: new Set<string>(),
            cancelledOrders: new Set<string>(),
            buyerOrders: new Map<string, Set<string>>(),
            lastOrdered: o.placedAt,
          } satisfies Acc);
        byProduct.set(key, p);

        if (cancelled) {
          p.cancelledOrders.add(o.id);
          continue;
        }
        p.units += item.qty;
        p.revenueCents += item.qty * item.unitPriceCents;
        p.orders.add(o.id);
        if (o.customerId) {
          const seen = p.buyerOrders.get(o.customerId) ?? new Set<string>();
          seen.add(o.id);
          p.buyerOrders.set(o.customerId, seen);
        }
        if (o.placedAt > p.lastOrdered) p.lastOrdered = o.placedAt;
      }
    }

    const totalRevenueCents = [...byProduct.values()].reduce(
      (n, p) => n + p.revenueCents,
      0,
    );
    const rows: ProductInsightResponse[] = [...byProduct.values()]
      .map((p) => {
        const buyers = p.buyerOrders.size;
        const repeatBuyers = [...p.buyerOrders.values()].filter(
          (seen) => seen.size >= 2,
        ).length;
        const placed = p.orders.size + p.cancelledOrders.size;
        return {
          name: p.name,
          units: p.units,
          orders: p.orders.size,
          buyers,
          repeatBuyers,
          repeatRate: pctOf(repeatBuyers, buyers),
          revenue: centsToDollars(p.revenueCents),
          revenueShare: pctOf(p.revenueCents, totalRevenueCents),
          cancelledOrders: p.cancelledOrders.size,
          cancelRate: pctOf(p.cancelledOrders.size, placed),
          averageUnitsPerOrder: p.orders.size
            ? Math.round((p.units / p.orders.size) * 10) / 10
            : 0,
          lastOrdered: p.lastOrdered.toISOString(),
        };
      })
      .sort((a, b) => b.revenue - a.revenue || b.units - a.units);

    // How concentrated the shop is: how few products carry 80% of revenue.
    let running = 0;
    let paretoCount = 0;
    for (const r of rows) {
      if (running >= PARETO_TARGET * 100) break;
      running += r.revenueShare;
      paretoCount += 1;
    }

    return {
      rows,
      totalRevenue: centsToDollars(totalRevenueCents),
      paretoCount,
      paretoShare: Math.round(Math.min(running, 100) * 10) / 10,
    };
  }

  private async computeRepeatRate(shopId: string): Promise<number> {
    const all = await this.db
      .select({ ordersCount: customers.ordersCount })
      .from(customers)
      .where(eq(customers.shopId, shopId));
    if (all.length === 0) return 0;
    return pctOf(all.filter((c) => c.ordersCount > 1).length, all.length);
  }
}

/** Average of a cent total over a count, in dollars. */
function avgCents(totalCents: number, count: number): number {
  return count > 0 ? centsToDollars(Math.round(totalCents / count)) : 0;
}

/** Escapes a CSV cell (quotes/commas/newlines). */
function csvCell(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
