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
import type {
  PaymentMethodRow,
  SettlementMethodSnapshot,
  SettlementRow,
} from '../../database/schema';
import { ShopsService } from '../shops/shops.service';
import { PaymentMethodsService } from './payment-methods.service';
import {
  CARD_FEE_BP,
  MBANK_FEE_BP,
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

/** Raw money buckets for one shop-month: per method code, all integer cents. */
interface Buckets {
  ordersCount: number;
  totalCents: number;
  /** Orders recorded manually from the console — no payment method. */
  manualCents: number;
  byCode: Map<string, number>;
}

/** A month classified against the payment-method catalog. */
interface MonthCore {
  ordersCount: number;
  totalCents: number;
  codCents: number;
  otherCents: number;
  /** Online (fee-carrying) methods, each with its fee applied. */
  online: SettlementMethodSnapshot[];
}

type MethodCatalog = Map<string, PaymentMethodRow>;

function emptyBuckets(): Buckets {
  return { ordersCount: 0, totalCents: 0, manualCents: 0, byCode: new Map() };
}

/**
 * Monthly payout accounting for prepaid (online) orders.
 *
 * Pending months are always aggregated live from `orders` and classified
 * against the platform's payment-method catalog (each method carries its own
 * fee rate), so refunds, late orders and fee changes are reflected until the
 * moment a platform operator marks the month paid — that writes an immutable
 * per-method snapshot which is used for display from then on. Only 'Paid'
 * orders count; COD and manually recorded orders are shown for context but
 * never paid out (the seller already holds that money).
 */
@Injectable()
export class SettlementsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly shops: ShopsService,
    private readonly methods: PaymentMethodsService,
  ) {}

  /** Shop admin: every earnings month, newest first. */
  async forShop(shopId: string): Promise<ShopSettlementsResponse> {
    await this.shops.requireById(shopId);
    const [catalog, methodViews, banner, rows, paidRows] = await Promise.all([
      this.methods.byCode(),
      this.methods.listEnabled(),
      this.methods.getBanner(),
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
      const b = byPeriod.get(period) ?? emptyBuckets();
      addOrder(b, r.paymentMethod, r.totalCents, 1);
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
          this.buildMonth(p, byPeriod.get(p), paidByPeriod.get(p), catalog),
        );
      }
    }
    return { methods: methodViews, banner, months };
  }

  /** Platform admin: every shop's numbers for one earnings month. */
  async forPlatform(period?: string): Promise<PlatformSettlementsResponse> {
    const selected = period ?? previousPeriod(currentPeriod());
    const [from, end] = monthRange(selected);

    const [catalog, grouped, paidRows, firstOrder] = await Promise.all([
      this.methods.byCode(),
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
      const b = byShop.get(g.shopId) ?? emptyBuckets();
      addOrder(b, g.method, g.cents, g.count);
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
          catalog,
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

    const catalog = await this.methods.byCode();
    const buckets = await this.bucketsFor(shopId, period);
    const core = classify(buckets, catalog);
    const payout = payoutCents(core);
    if (payout <= 0) {
      throw new BadRequestException(
        'No online payments this month — there is nothing to pay out.',
      );
    }
    // The mbank/card columns predate dynamic methods; they are still filled
    // (grouped by method kind) so older tooling keeps reading sane numbers.
    const kindCents = (kind: 'mbank' | 'card') =>
      core.online
        .filter((m) => catalog.get(m.code)?.kind === kind)
        .reduce((sum, m) => sum + m.cents, 0);
    const snapshot = {
      ordersCount: core.ordersCount,
      totalCents: core.totalCents,
      codCents: core.codCents,
      mbankCents: kindCents('mbank'),
      cardCents: kindCents('card'),
      otherCents: core.otherCents,
      feeCents: totalFeeCents(core),
      payoutCents: payout,
      mbankFeeBp: catalog.get('mbank')?.feeBp ?? MBANK_FEE_BP,
      cardFeeBp: catalog.get('card')?.feeBp ?? CARD_FEE_BP,
      breakdown: core.online,
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
      ...this.buildMonth(period, buckets, paidRow, await this.methods.byCode()),
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
    const b = emptyBuckets();
    for (const r of rows) addOrder(b, r.paymentMethod, r.totalCents, 1);
    return b;
  }

  /** Assembles the API shape for one month from live buckets or a snapshot. */
  private buildMonth(
    period: string,
    live: Buckets | undefined,
    paid: SettlementRow | undefined,
    catalog: MethodCatalog,
  ): SettlementMonthResponse {
    // A paid month renders from its snapshot — amounts *and* the fee rates in
    // force at payment time — so the record never shifts under a rate change.
    const core: MonthCore = paid
      ? snapshotCore(paid)
      : classify(live ?? emptyBuckets(), catalog);
    const payout = paid ? paid.payoutCents : payoutCents(core);
    const onlineCents = core.online.reduce((sum, m) => sum + m.cents, 0);
    const window = windowOf(period);
    return {
      period,
      ordersCount: core.ordersCount,
      total: centsToDollars(core.totalCents),
      cod: centsToDollars(core.codCents),
      online: centsToDollars(onlineCents),
      other: centsToDollars(core.otherCents),
      methods: core.online.map((m) => ({
        code: m.code,
        title: m.title,
        amount: centsToDollars(m.cents),
        feePercent: m.feeBp / 100,
        fee: centsToDollars(m.feeCents),
      })),
      fees: centsToDollars(totalFeeCents(core)),
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
  method: string | null,
  cents: number,
  count: number,
): void {
  b.ordersCount += count;
  b.totalCents += cents;
  // Orders recorded manually from the console have no gateway — the seller
  // was paid directly, so like COD they carry no fee and no payout.
  if (!method) b.manualCents += cents;
  else b.byCode.set(method, (b.byCode.get(method) ?? 0) + cents);
}

/**
 * Splits raw per-code volume into COD / online / other using the method
 * catalog. Codes the catalog no longer knows (hard-deleted methods) join the
 * manual bucket — no fee, no payout — so money never silently disappears.
 */
function classify(b: Buckets, catalog: MethodCatalog): MonthCore {
  let codCents = 0;
  let otherCents = b.manualCents;
  const online: SettlementMethodSnapshot[] = [];
  for (const [code, cents] of b.byCode) {
    const method = catalog.get(code);
    if (!method) otherCents += cents;
    else if (method.kind === 'cod') codCents += cents;
    else {
      online.push({
        code,
        title: method.title,
        cents,
        feeBp: method.feeBp,
        feeCents: feeCents(cents, method.feeBp),
      });
    }
  }
  online.sort((a, b2) => b2.cents - a.cents);
  return {
    ordersCount: b.ordersCount,
    totalCents: b.totalCents,
    codCents,
    otherCents,
    online,
  };
}

/** Rebuilds a MonthCore from a paid snapshot row (legacy rows included). */
function snapshotCore(paid: SettlementRow): MonthCore {
  // Rows written before per-method snapshots reconstruct their two-bucket
  // breakdown from the legacy mbank/card columns and their frozen rates.
  const online: SettlementMethodSnapshot[] =
    paid.breakdown ??
    [
      {
        code: 'mbank',
        title: 'Mobile banking',
        cents: paid.mbankCents,
        feeBp: paid.mbankFeeBp,
        feeCents: feeCents(paid.mbankCents, paid.mbankFeeBp),
      },
      {
        code: 'card',
        title: 'Card',
        cents: paid.cardCents,
        feeBp: paid.cardFeeBp,
        feeCents: feeCents(paid.cardCents, paid.cardFeeBp),
      },
    ].filter((m) => m.cents > 0);
  return {
    ordersCount: paid.ordersCount,
    totalCents: paid.totalCents,
    codCents: paid.codCents,
    otherCents: paid.otherCents,
    online,
  };
}

function totalFeeCents(core: MonthCore): number {
  return core.online.reduce((sum, m) => sum + m.feeCents, 0);
}

function payoutCents(core: MonthCore): number {
  return core.online.reduce((sum, m) => sum + m.cents - m.feeCents, 0);
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
