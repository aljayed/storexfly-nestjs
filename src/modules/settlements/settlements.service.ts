import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { centsToDollars } from '../../common/utils/money.util';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import { orders, settlements, shops } from '../../database/schema';
import type { SettlementRow } from '../../database/schema';
import { ShopsService } from '../shops/shops.service';
import { FeesService, type FeeRates } from './fees.service';
import {
  SETTLEMENT_WINDOW_END_DAY,
  SETTLEMENT_WINDOW_START_DAY,
  feeCents,
  type SettlementStatus,
} from './settlement.constants';
import type {
  SettlementMonthResponse,
  ShopSettlementsResponse,
} from './dto/settlement.response';
import type {
  PlatformSettlementRowResponse,
  PlatformSettlementsResponse,
  PlatformSettlementTotalResponse,
} from './dto/platform-settlement.response';

/** Money buckets for one shop-month, all in integer cents. */
interface Buckets {
  ordersCount: number;
  totalCents: number;
  codCents: number;
  mbankCents: number;
  cardCents: number;
  otherCents: number;
}

const EMPTY_BUCKETS: Buckets = {
  ordersCount: 0,
  totalCents: 0,
  codCents: 0,
  mbankCents: 0,
  cardCents: 0,
  otherCents: 0,
};

/**
 * Monthly payout accounting for prepaid (online) orders.
 *
 * Pending months are always aggregated live from `orders`, so refunds and
 * late-arriving orders are reflected until the moment a platform operator
 * marks the month paid — that writes an immutable snapshot row which is used
 * for display from then on. Only 'Paid' orders count; COD and manually
 * recorded orders are shown for context but never paid out (the seller
 * already holds that money).
 */
@Injectable()
export class SettlementsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly shops: ShopsService,
    private readonly fees: FeesService,
  ) {}

  /** Shop admin: every earnings month, newest first. */
  async forShop(shopId: string): Promise<ShopSettlementsResponse> {
    await this.shops.requireById(shopId);
    const rates = await this.fees.getRates();
    const [rows, paidRows] = await Promise.all([
      this.db.query.orders.findMany({
        where: and(eq(orders.shopId, shopId), eq(orders.pay, 'Paid')),
        columns: { totalCents: true, paymentMethod: true, placedAt: true },
      }),
      this.db.query.settlements.findMany({
        where: eq(settlements.shopId, shopId),
      }),
    ]);

    const byPeriod = new Map<string, Buckets>();
    for (const r of rows) {
      const period = periodOf(r.placedAt);
      const b = byPeriod.get(period) ?? { ...EMPTY_BUCKETS };
      addOrder(b, r.paymentMethod, r.totalCents);
      byPeriod.set(period, b);
    }
    const paidByPeriod = new Map(paidRows.map((s) => [s.period, s]));

    // Continuous month range from the first order to today, so quiet months
    // still appear (as "nothing to settle") instead of silently vanishing.
    const months: SettlementMonthResponse[] = [];
    const allPeriods = [...byPeriod.keys(), ...paidByPeriod.keys()];
    if (allPeriods.length) {
      const first = allPeriods.sort()[0];
      for (let p = currentPeriod(); p >= first; p = previousPeriod(p)) {
        months.push(
          this.buildMonth(p, byPeriod.get(p), paidByPeriod.get(p), rates),
        );
      }
    }
    return {
      feePercents: { mbank: rates.mbankBp / 100, card: rates.cardBp / 100 },
      months,
    };
  }

  /** Platform admin: every shop's numbers for one earnings month. */
  async forPlatform(period?: string): Promise<PlatformSettlementsResponse> {
    const selected = period ?? previousPeriod(currentPeriod());
    const [from, end] = monthRange(selected);
    const rates = await this.fees.getRates();

    const [grouped, paidRows, firstOrder] = await Promise.all([
      this.db
        .select({
          shopId: orders.shopId,
          method: orders.paymentMethod,
          count: sql<number>`count(*)::int`,
          cents: sql<number>`coalesce(sum(${orders.totalCents}), 0)::int`,
        })
        .from(orders)
        .where(
          and(
            eq(orders.pay, 'Paid'),
            gte(orders.placedAt, from),
            lt(orders.placedAt, end),
          ),
        )
        .groupBy(orders.shopId, orders.paymentMethod),
      this.db.query.settlements.findMany({
        where: eq(settlements.period, selected),
      }),
      this.db
        .select({ placedAt: orders.placedAt })
        .from(orders)
        .orderBy(asc(orders.placedAt))
        .limit(1),
    ]);

    const byShop = new Map<string, Buckets>();
    for (const g of grouped) {
      const b = byShop.get(g.shopId) ?? { ...EMPTY_BUCKETS };
      addBucket(b, g.method, g.cents, g.count);
      byShop.set(g.shopId, b);
    }
    const paidByShop = new Map(paidRows.map((s) => [s.shopId, s]));

    const shopIds = [...new Set([...byShop.keys(), ...paidByShop.keys()])];
    const shopRows = shopIds.length
      ? await this.db.query.shops.findMany({
          where: inArray(shops.id, shopIds),
          columns: { id: true, name: true, handle: true, currency: true },
        })
      : [];

    const rows: PlatformSettlementRowResponse[] = shopRows
      .map((s) => ({
        shopId: s.id,
        shopName: s.name,
        shopHandle: s.handle,
        currency: s.currency,
        ...this.buildMonth(
          selected,
          byShop.get(s.id),
          paidByShop.get(s.id),
          rates,
        ),
      }))
      // Biggest payouts first — the ones the operator needs to act on.
      .sort((a, b) => b.payout - a.payout || b.total - a.total);

    const totals = new Map<string, PlatformSettlementTotalResponse>();
    for (const r of rows) {
      const t = totals.get(r.currency) ?? {
        currency: r.currency,
        pendingPayout: 0,
        paidPayout: 0,
      };
      if (r.status === 'paid') t.paidPayout += r.payout;
      else t.pendingPayout += r.payout;
      totals.set(r.currency, t);
    }

    return {
      period: selected,
      periods: listPeriods(firstOrder[0]?.placedAt),
      feePercents: { mbank: rates.mbankBp / 100, card: rates.cardBp / 100 },
      rows,
      totals: [...totals.values()],
    };
  }

  /** Platform admin: record (or undo) one shop-month payout. */
  async decide(
    shopId: string,
    period: string,
    paid: boolean,
    note?: string,
  ): Promise<PlatformSettlementRowResponse> {
    const shop = await this.shops.requireById(shopId);
    if (period >= currentPeriod()) {
      throw new BadRequestException(
        'Only completed months can be settled — this month is still accruing.',
      );
    }

    if (!paid) {
      const deleted = await this.db
        .delete(settlements)
        .where(
          and(eq(settlements.shopId, shopId), eq(settlements.period, period)),
        )
        .returning({ id: settlements.id });
      if (!deleted.length) {
        throw new NotFoundException('This month has not been marked paid.');
      }
      return this.platformRow(shop, period);
    }

    const rates = await this.fees.getRates();
    const buckets = await this.bucketsFor(shopId, period);
    const payout = payoutCents(buckets, rates);
    if (payout <= 0) {
      throw new BadRequestException(
        'No online payments this month — there is nothing to pay out.',
      );
    }
    const snapshot = {
      ordersCount: buckets.ordersCount,
      totalCents: buckets.totalCents,
      codCents: buckets.codCents,
      mbankCents: buckets.mbankCents,
      cardCents: buckets.cardCents,
      otherCents: buckets.otherCents,
      feeCents: totalFeeCents(buckets, rates),
      payoutCents: payout,
      mbankFeeBp: rates.mbankBp,
      cardFeeBp: rates.cardBp,
      note: note?.trim() || null,
      paidAt: new Date(),
    };
    await this.db
      .insert(settlements)
      .values({ shopId, period, ...snapshot })
      .onConflictDoUpdate({
        target: [settlements.shopId, settlements.period],
        set: snapshot,
      });
    return this.platformRow(shop, period);
  }

  /** Rebuilds one platform table row after a decision. */
  private async platformRow(
    shop: { id: string; name: string; handle: string; currency: string },
    period: string,
  ): Promise<PlatformSettlementRowResponse> {
    const paidRow = await this.db.query.settlements.findFirst({
      where: and(
        eq(settlements.shopId, shop.id),
        eq(settlements.period, period),
      ),
    });
    const buckets = paidRow
      ? undefined
      : await this.bucketsFor(shop.id, period);
    return {
      shopId: shop.id,
      shopName: shop.name,
      shopHandle: shop.handle,
      currency: shop.currency,
      ...this.buildMonth(period, buckets, paidRow, await this.fees.getRates()),
    };
  }

  /** Live aggregation of one shop-month from the orders table. */
  private async bucketsFor(shopId: string, period: string): Promise<Buckets> {
    const [from, end] = monthRange(period);
    const rows = await this.db.query.orders.findMany({
      where: and(
        eq(orders.shopId, shopId),
        eq(orders.pay, 'Paid'),
        gte(orders.placedAt, from),
        lt(orders.placedAt, end),
      ),
      columns: { totalCents: true, paymentMethod: true },
    });
    const b: Buckets = { ...EMPTY_BUCKETS };
    for (const r of rows) addOrder(b, r.paymentMethod, r.totalCents);
    return b;
  }

  /** Assembles the API shape for one month from live buckets or a snapshot. */
  private buildMonth(
    period: string,
    live: Buckets | undefined,
    paid: SettlementRow | undefined,
    rates: FeeRates,
  ): SettlementMonthResponse {
    // A paid month renders from its snapshot — amounts *and* the fee rates in
    // force at payment time — so the record never shifts under a rate change.
    const b: Buckets = paid
      ? {
          ordersCount: paid.ordersCount,
          totalCents: paid.totalCents,
          codCents: paid.codCents,
          mbankCents: paid.mbankCents,
          cardCents: paid.cardCents,
          otherCents: paid.otherCents,
        }
      : (live ?? { ...EMPTY_BUCKETS });
    const applied = paid
      ? { mbankBp: paid.mbankFeeBp, cardBp: paid.cardFeeBp }
      : rates;
    const mbankFee = feeCents(b.mbankCents, applied.mbankBp);
    const cardFee = feeCents(b.cardCents, applied.cardBp);
    const payout = paid ? paid.payoutCents : payoutCents(b, rates);
    const window = windowOf(period);
    return {
      period,
      ordersCount: b.ordersCount,
      total: centsToDollars(b.totalCents),
      cod: centsToDollars(b.codCents),
      mbank: centsToDollars(b.mbankCents),
      card: centsToDollars(b.cardCents),
      other: centsToDollars(b.otherCents),
      fees: {
        mbank: centsToDollars(mbankFee),
        card: centsToDollars(cardFee),
        total: centsToDollars(mbankFee + cardFee),
      },
      payout: centsToDollars(payout),
      status: statusOf(period, !!paid, payout),
      windowFrom: window.from,
      windowTo: window.to,
      paidAt: paid?.paidAt.toISOString(),
      note: paid?.note ?? undefined,
    };
  }
}

/* ── Bucket math ────────────────────────────────────────────────── */

function addOrder(
  b: Buckets,
  method: 'mbank' | 'card' | 'cod' | null,
  cents: number,
): void {
  addBucket(b, method, cents, 1);
}

function addBucket(
  b: Buckets,
  method: 'mbank' | 'card' | 'cod' | null,
  cents: number,
  count: number,
): void {
  b.ordersCount += count;
  b.totalCents += cents;
  if (method === 'cod') b.codCents += cents;
  else if (method === 'mbank') b.mbankCents += cents;
  else if (method === 'card') b.cardCents += cents;
  // Orders recorded manually from the console have no gateway — the seller
  // was paid directly, so like COD they carry no fee and no payout.
  else b.otherCents += cents;
}

function totalFeeCents(b: Buckets, rates: FeeRates): number {
  return (
    feeCents(b.mbankCents, rates.mbankBp) + feeCents(b.cardCents, rates.cardBp)
  );
}

function payoutCents(b: Buckets, rates: FeeRates): number {
  return b.mbankCents + b.cardCents - totalFeeCents(b, rates);
}

/* ── Calendar helpers (server-local months, matching the dashboard) ─ */

function periodOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function currentPeriod(): string {
  return periodOf(new Date());
}

function previousPeriod(period: string): string {
  const [y, m] = period.split('-').map(Number);
  return periodOf(new Date(y, m - 2, 1));
}

/** [start, end) instants of one "YYYY-MM" month in server-local time. */
function monthRange(period: string): [Date, Date] {
  const [y, m] = period.split('-').map(Number);
  return [new Date(y, m - 1, 1), new Date(y, m, 1)];
}

/** The 15th–21st payout window in the month after the earnings month. */
function windowOf(period: string): { from: string; to: string } {
  const [y, m] = period.split('-').map(Number);
  const next = new Date(y, m, 1); // first day of the following month
  const iso = (day: number) =>
    `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return {
    from: iso(SETTLEMENT_WINDOW_START_DAY),
    to: iso(SETTLEMENT_WINDOW_END_DAY),
  };
}

function statusOf(
  period: string,
  paid: boolean,
  payoutCents: number,
): SettlementStatus {
  if (paid) return 'paid';
  if (period >= currentPeriod()) return 'accruing';
  if (payoutCents <= 0) return 'none';
  const { from, to } = windowOf(period);
  const today =
    periodOf(new Date()) + '-' + String(new Date().getDate()).padStart(2, '0');
  if (today < from) return 'scheduled';
  if (today <= to) return 'due';
  return 'overdue';
}

/** Every month from the first order to now, newest first. */
function listPeriods(firstOrderAt: Date | undefined): string[] {
  if (!firstOrderAt) return [currentPeriod()];
  const first = periodOf(firstOrderAt);
  const out: string[] = [];
  for (
    let p = currentPeriod();
    p >= first && out.length < 60;
    p = previousPeriod(p)
  ) {
    out.push(p);
  }
  return out;
}
