import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { centsToDollars } from '../../common/utils/money.util';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import {
  deletedShopSettlements,
  orders,
  settlements,
  shops,
} from '../../database/schema';
import type {
  DeletedShopSettlementRow,
  SettlementRow,
} from '../../database/schema';
import { ShopsService } from '../shops/shops.service';
import { PaymentMethodsService } from './payment-methods.service';
import { CARD_FEE_BP, MBANK_FEE_BP } from './settlement.constants';
import {
  addOrder,
  classify,
  currentPeriod,
  emptyBuckets,
  listPeriods,
  monthRange,
  payoutCents,
  periodOf,
  previousPeriod,
  snapshotCore,
  statusOf,
  totalFeeCents,
  windowOf,
  type Buckets,
  type MethodCatalog,
  type MonthCore,
} from './settlement-core';
import type {
  SettlementMonthResponse,
  ShopSettlementsResponse,
} from './dto/settlement.response';
import type {
  DeletedShopSettlementResponse,
  PlatformSettlementRowResponse,
  PlatformSettlementsResponse,
  PlatformSettlementTotalResponse,
} from './dto/platform-settlement.response';

/**
 * Monthly payout accounting for prepaid (online) orders.
 *
 * Pending months are always aggregated live from `orders` and classified
 * against the platform's payment-method catalog (each method carries its own
 * fee rate), so refunds, late orders and fee changes are reflected until the
 * moment a platform operator marks the month paid - that writes an immutable
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
      // Biggest payouts first - the ones the operator needs to act on.
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
        'Only completed months can be settled - this month is still accruing.',
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
        'No online payments this month - there is nothing to pay out.',
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

  /**
   * Platform admin: money still owed to shops that were deleted. These
   * snapshots were written by the delete-shop transaction; they are the only
   * record left (the orders cascaded away), so they are paid from here.
   */
  async listDeleted(): Promise<DeletedShopSettlementResponse[]> {
    const rows = await this.db.query.deletedShopSettlements.findMany({
      orderBy: [desc(deletedShopSettlements.owedAt)],
    });
    return rows.map(deletedResponse);
  }

  /** Platform admin: record (or undo) the transfer of one owed month. */
  async decideDeleted(
    id: string,
    paid: boolean,
    note?: string,
  ): Promise<DeletedShopSettlementResponse> {
    const [row] = await this.db
      .update(deletedShopSettlements)
      .set({
        paidAt: paid ? new Date() : null,
        note: paid ? note?.trim() || null : null,
      })
      .where(eq(deletedShopSettlements.id, id))
      .returning();
    if (!row) {
      throw new NotFoundException('Owed settlement not found');
    }
    return deletedResponse(row);
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
    // A paid month renders from its snapshot - amounts *and* the fee rates in
    // force at payment time - so the record never shifts under a rate change.
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

/** API shape for one owed month of a deleted shop. */
function deletedResponse(
  row: DeletedShopSettlementRow,
): DeletedShopSettlementResponse {
  const window = windowOf(row.period);
  return {
    id: row.id,
    shopId: row.shopId,
    shopName: row.shopName,
    shopHandle: row.shopHandle,
    currency: row.currency,
    ownerEmail: row.ownerEmail ?? undefined,
    period: row.period,
    ordersCount: row.ordersCount,
    total: centsToDollars(row.totalCents),
    fees: centsToDollars(row.feeCents),
    payout: centsToDollars(row.payoutCents),
    methods: row.breakdown?.map((m) => ({
      code: m.code,
      title: m.title,
      amount: centsToDollars(m.cents),
      feePercent: m.feeBp / 100,
      fee: centsToDollars(m.feeCents),
    })),
    payoutBank: row.payoutBank ?? undefined,
    windowFrom: window.from,
    windowTo: window.to,
    owedAt: row.owedAt.toISOString(),
    paidAt: row.paidAt?.toISOString(),
    note: row.note ?? undefined,
    status: row.paidAt ? 'paid' : 'owed',
  };
}
