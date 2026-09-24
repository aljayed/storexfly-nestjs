import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  sql,
} from 'drizzle-orm';
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
  SettlementProof,
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
  monthRange,
  payoutCents,
  periodOf,
  settledOnOf,
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
  SettlementProofResponse,
  SettlementReceiptResponse,
  ShopSettlementsResponse,
} from './dto/settlement.response';
import type {
  DeletedShopSettlementResponse,
  PlatformSettlementRowResponse,
  PlatformSettlementsResponse,
  PlatformSettlementTotalResponse,
} from './dto/platform-settlement.response';

/** Split protected COD into the platform-held advance and door-collected
 * balance. Keeping both buckets makes sales totals reconcile without ever
 * paying the seller the COD portion from platform funds. */
function addOrderForSettlement(
  bucket: Buckets,
  order: {
    paymentMethod: string | null;
    totalCents: number;
    advanceCents: number;
    pay: string;
  },
): void {
  if (order.advanceCents > 0) {
    addOrder(bucket, order.paymentMethod, order.advanceCents, 1);
    if (order.pay === 'Paid') {
      addOrder(bucket, 'cod', order.totalCents - order.advanceCents, 0);
    }
    return;
  }
  addOrder(bucket, order.paymentMethod, order.totalCents, 1);
}

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

  /**
   * When an order joins a payout cycle.
   *
   * The courier's delivery stamp, because a payout follows the goods. A
   * manually delivered order has no such stamp - nobody reports those - so it
   * falls back to the handover, which is the last thing the platform can see
   * of it. An order with neither has not been delivered and is in no cycle
   * yet; it will join the one it arrives in.
   */
  private static readonly settledOn = sql`coalesce(${orders.deliveredAt}, case when ${orders.deliveryMode} = 'manual' then ${orders.handedOverAt} end)`;

  /**
   * One cycle's half-open window, as a condition on `settledOn`.
   *
   * The boundaries are bound as ISO text and cast back, which is not
   * decoration: `settledOn` is an expression rather than a column, so the
   * driver has no column type to map a JS Date onto and rejects the
   * parameter outright - the whole query fails before Postgres sees it. The
   * cast is what gives the comparison a type on both sides.
   */
  static settledWithin(from: Date, end: Date) {
    const at = (when: Date) => sql`${when.toISOString()}::timestamptz`;
    return and(
      gte(SettlementsService.settledOn, at(from)),
      lt(SettlementsService.settledOn, at(end)),
    );
  }

  /** Shop admin: every payout cycle, newest first. */
  async forShop(shopId: string): Promise<ShopSettlementsResponse> {
    await this.shops.requireById(shopId);
    const [catalog, methodViews, banner, rows, paidRows] = await Promise.all([
      this.methods.byCode(),
      this.methods.listEnabled(),
      this.methods.getBanner(),
      this.db.query.orders.findMany({
        where: and(
          eq(orders.shopId, shopId),
          or(eq(orders.pay, 'Paid'), isNotNull(orders.advancePaidAt)),
          ne(orders.status, 'Cancelled'),
          ne(orders.pay, 'Refunded'),
          // An exchange replacement carries the money of the order it
          // replaces, which has already been settled. Paying out on both
          // would pay the shop twice for one sale.
          isNull(orders.exchangedFromOrderId),
        ),
        columns: {
          totalCents: true,
          paymentMethod: true,
          advanceCents: true,
          pay: true,
          deliveredAt: true,
          handedOverAt: true,
          deliveryMode: true,
        },
      }),
      this.db.query.settlements.findMany({
        where: eq(settlements.shopId, shopId),
      }),
    ]);

    const byPeriod = new Map<string, Buckets>();
    for (const r of rows) {
      // Undelivered money is nobody's payout yet - it joins the cycle the
      // parcel arrives in, whenever that turns out to be.
      const arrived = settledOnOf(r);
      if (!arrived) continue;
      const period = periodOf(arrived);
      const b = byPeriod.get(period) ?? emptyBuckets();
      addOrderForSettlement(b, r);
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

  /**
   * Platform admin: every shop's numbers for one payout cycle.
   *
   * Which cycle a delivery belongs to is decided in TypeScript, on the
   * seller's calendar - so the months are read the same way here as on the
   * seller's own screen, from one definition of the rule. That means reading
   * every delivered order rather than only the selected month's, which is
   * what lets the screen say which *other* cycles still owe somebody money
   * instead of leaving the operator to hunt through the picker. At this
   * platform's size that is a small read; if the order table ever outgrows
   * it, the bucketing is what to move into SQL.
   */
  async forPlatform(period?: string): Promise<PlatformSettlementsResponse> {
    const [catalog, rows, paidRows] = await Promise.all([
      this.methods.byCode(),
      this.db.query.orders.findMany({
        where: and(
          or(eq(orders.pay, 'Paid'), isNotNull(orders.advancePaidAt)),
          ne(orders.status, 'Cancelled'),
          ne(orders.pay, 'Refunded'),
          // An exchange replacement carries the money of the order it
          // replaces, which has already been settled. Paying out on both
          // would pay the shop twice for one sale.
          isNull(orders.exchangedFromOrderId),
        ),
        columns: {
          shopId: true,
          paymentMethod: true,
          totalCents: true,
          advanceCents: true,
          pay: true,
          deliveredAt: true,
          handedOverAt: true,
          deliveryMode: true,
        },
      }),
      this.db.query.settlements.findMany(),
    ]);

    // cycle -> shop -> what arrived in it
    const byPeriod = new Map<string, Map<string, Buckets>>();
    for (const r of rows) {
      // Undelivered money is nobody's payout yet - it joins the cycle the
      // parcel arrives in, whenever that turns out to be.
      const arrived = settledOnOf(r);
      if (!arrived) continue;
      const shops =
        byPeriod.get(periodOf(arrived)) ?? new Map<string, Buckets>();
      const b = shops.get(r.shopId) ?? emptyBuckets();
      addOrderForSettlement(b, r);
      shops.set(r.shopId, b);
      byPeriod.set(periodOf(arrived), shops);
    }

    const paidByPeriod = new Map<string, Map<string, SettlementRow>>();
    for (const row of paidRows) {
      const shops =
        paidByPeriod.get(row.period) ?? new Map<string, SettlementRow>();
      shops.set(row.shopId, row);
      paidByPeriod.set(row.period, shops);
    }

    // A cycle is worth offering if something was delivered into it, if it has
    // already been paid out, or if it is the one now collecting.
    const periods = [
      ...new Set([...byPeriod.keys(), ...paidByPeriod.keys(), currentPeriod()]),
    ].sort((a, b) => b.localeCompare(a));

    // The ones still holding money for somebody. A cycle already paid out
    // counts again if deliveries have landed in it since, because the
    // snapshot no longer covers what the shop is owed. The operator lands on
    // the newest of these, so a shop with a delivery is never a dropdown
    // away.
    const unsettled = periods.filter((p) => {
      const shopsInCycle = byPeriod.get(p);
      if (!shopsInCycle) return false;
      return [...shopsInCycle].some(
        ([shopId, b]) =>
          payoutCents(classify(b, catalog)) >
          (paidByPeriod.get(p)?.get(shopId)?.payoutCents ?? 0),
      );
    });

    const selected = period ?? unsettled[0] ?? periods[0];
    const liveShops = byPeriod.get(selected) ?? new Map<string, Buckets>();
    const paidShops =
      paidByPeriod.get(selected) ?? new Map<string, SettlementRow>();

    const shopIds = [...new Set([...liveShops.keys(), ...paidShops.keys()])];
    const shopRows = shopIds.length
      ? await this.db.query.shops.findMany({
          where: inArray(shops.id, shopIds),
          columns: { id: true, name: true, handle: true, currency: true },
        })
      : [];

    const built: PlatformSettlementRowResponse[] = shopRows
      .map((s) => ({
        shopId: s.id,
        shopName: s.name,
        shopHandle: s.handle,
        currency: s.currency,
        ...this.buildMonth(
          selected,
          liveShops.get(s.id),
          paidShops.get(s.id),
          catalog,
        ),
      }))
      // Biggest payouts first - the ones the operator needs to act on.
      .sort((a, b) => b.payout - a.payout || b.total - a.total);

    const totals = new Map<string, PlatformSettlementTotalResponse>();
    for (const r of built) {
      const t = totals.get(r.currency) ?? {
        currency: r.currency,
        pendingPayout: 0,
        paidPayout: 0,
      };
      if (r.status === 'paid') t.paidPayout += r.payout;
      else t.pendingPayout += r.payout;
      // Money delivered into a cycle since it was paid out is still owed.
      if (r.unrecorded) t.pendingPayout += r.unrecorded;
      totals.set(r.currency, t);
    }

    return {
      period: selected,
      periods,
      unsettled,
      rows: built,
      totals: [...totals.values()],
    };
  }

  /** Platform admin: record (or undo) one shop-month payout. */
  async decide(
    shopId: string,
    period: string,
    paid: boolean,
    note?: string,
    proof?: { data: string; name?: string },
  ): Promise<PlatformSettlementRowResponse> {
    const shop = await this.shops.requireById(shopId);
    // A payout is recorded when the money is actually transferred, and that
    // is the operator's call - including out of a cycle that is still taking
    // deliveries. Anything that lands in it afterwards is picked up by
    // recording the payout again, which rewrites the snapshot.

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

    if (!proof?.data) {
      throw new BadRequestException({
        error: 'PayoutProofRequired',
        message:
          'Attach the receipt for this transfer - the seller is shown it as ' +
          'the proof they were paid.',
      });
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

    // Receipts append. A cycle still taking deliveries can be paid more than
    // once, and each transfer is its own document; replacing would leave the
    // seller with a receipt that does not account for what they were sent
    // the first time.
    const existing = await this.db.query.settlements.findFirst({
      where: and(
        eq(settlements.shopId, shopId),
        eq(settlements.period, period),
      ),
      columns: { proofs: true },
    });
    const proofs: SettlementProof[] = [
      ...(existing?.proofs ?? []),
      {
        data: proof.data,
        name: proof.name?.trim() || undefined,
        payoutCents: payout,
        at: new Date().toISOString(),
      },
    ];
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
      proofs,
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
   * One receipt, for whoever is entitled to it - the operator who recorded
   * the payout, or the seller it was paid to. The caller has already been
   * checked; this only finds the document.
   */
  async proofFor(
    shopId: string,
    period: string,
    index: number,
  ): Promise<SettlementProofResponse> {
    const row = await this.db.query.settlements.findFirst({
      where: and(
        eq(settlements.shopId, shopId),
        eq(settlements.period, period),
      ),
      columns: { proofs: true },
    });
    return pickProof(row?.proofs, index);
  }

  /** The same, for a payout owed to a shop that no longer exists. */
  async deletedProofFor(
    id: string,
    index: number,
  ): Promise<SettlementProofResponse> {
    const row = await this.db.query.deletedShopSettlements.findFirst({
      where: eq(deletedShopSettlements.id, id),
      columns: { proofs: true },
    });
    return pickProof(row?.proofs, index);
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
    proof?: { data: string; name?: string },
  ): Promise<DeletedShopSettlementResponse> {
    // The shop is gone, so there is no seller console for a receipt to
    // appear in. One is kept when the operator has it - it is the platform's
    // own record of the transfer - but not demanded, unlike a live shop's.
    const existing = await this.db.query.deletedShopSettlements.findFirst({
      where: eq(deletedShopSettlements.id, id),
      columns: { proofs: true, payoutCents: true },
    });
    const proofs =
      paid && proof?.data
        ? [
            ...(existing?.proofs ?? []),
            {
              data: proof.data,
              name: proof.name?.trim() || undefined,
              payoutCents: existing?.payoutCents ?? 0,
              at: new Date().toISOString(),
            },
          ]
        : paid
          ? (existing?.proofs ?? null)
          : null;

    const [row] = await this.db
      .update(deletedShopSettlements)
      .set({
        paidAt: paid ? new Date() : null,
        note: paid ? note?.trim() || null : null,
        proofs,
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
        or(eq(orders.pay, 'Paid'), isNotNull(orders.advancePaidAt)),
        ne(orders.status, 'Cancelled'),
        ne(orders.pay, 'Refunded'),
        isNull(orders.exchangedFromOrderId),
        SettlementsService.settledWithin(from, end),
      ),
      columns: {
        totalCents: true,
        paymentMethod: true,
        advanceCents: true,
        pay: true,
      },
    });
    const b = emptyBuckets();
    for (const r of rows) addOrderForSettlement(b, r);
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
    const liveCore = classify(live ?? emptyBuckets(), catalog);
    const core: MonthCore = paid ? snapshotCore(paid) : liveCore;
    const payout = paid ? paid.payoutCents : payoutCents(core);
    // A cycle can be paid out while it is still taking deliveries, so the
    // ones that arrive afterwards are money the snapshot does not cover.
    // Saying so is the difference between the operator recording the payout
    // again and the shop quietly going short.
    const unrecorded = paid
      ? Math.max(0, payoutCents(liveCore) - paid.payoutCents)
      : 0;
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
      unrecorded: unrecorded ? centsToDollars(unrecorded) : undefined,
      receipts: receiptsOf(paid?.proofs),
      status: statusOf(period, !!paid, payout),
      windowFrom: window.from,
      windowTo: window.to,
      paidAt: paid?.paidAt.toISOString(),
      note: paid?.note ?? undefined,
    };
  }
}

/**
 * What a receipt looks like in a list: enough to name it and say what it
 * settled, never the file. The documents are megabytes each and a history
 * carries a row per month, so they are fetched one at a time instead.
 */
/** One receipt's bytes, or a 404 if that is not a receipt anybody recorded. */
function pickProof(
  proofs: SettlementProof[] | null | undefined,
  index: number,
): SettlementProofResponse {
  const proof = proofs?.[index];
  if (!proof) throw new NotFoundException('No such receipt.');
  return {
    index,
    name: proof.name,
    at: proof.at,
    payout: centsToDollars(proof.payoutCents),
    mime: mimeOfDataUrl(proof.data),
    data: proof.data,
  };
}

function receiptsOf(
  proofs: SettlementProof[] | null | undefined,
): SettlementReceiptResponse[] | undefined {
  if (!proofs?.length) return undefined;
  return proofs.map((p, index) => ({
    index,
    name: p.name,
    at: p.at,
    payout: centsToDollars(p.payoutCents),
    mime: mimeOfDataUrl(p.data),
  }));
}

/** The media type a data URL declares, for a viewer that has not fetched it. */
function mimeOfDataUrl(data: string): string {
  return /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);/i.exec(data)?.[1] ?? '';
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
    receipts: receiptsOf(row.proofs),
    windowFrom: window.from,
    windowTo: window.to,
    owedAt: row.owedAt.toISOString(),
    paidAt: row.paidAt?.toISOString(),
    note: row.note ?? undefined,
    status: row.paidAt ? 'paid' : 'owed',
  };
}
