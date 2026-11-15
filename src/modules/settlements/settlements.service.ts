import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  forwardRef,
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
  type SQL,
} from 'drizzle-orm';
import { centsToDollars } from '../../common/utils/money.util';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import {
  deletedShopSettlements,
  orders,
  paymentLinks,
  serviceFeePayments,
  settlements,
  shops,
} from '../../database/schema';
import type {
  DeletedShopSettlementRow,
  SettlementProof,
  SettlementRow,
} from '../../database/schema';
import { serviceFeeBalanceCents } from '../service-fees/service-fee-balance';
import { ServiceFeesService } from '../service-fees/service-fees.service';
import { planPayout } from './settlement-plan';
import { ShopsService } from '../shops/shops.service';
import { PaymentMethodsService } from './payment-methods.service';
import {
  CARD_FEE_BP,
  MBANK_FEE_BP,
  RESELLER_CASH_MARGIN,
  RESELLER_ONLINE_MARGIN,
  SETTLEMENT_MIN_PAYOUT_CENTS,
  feeCents,
} from './settlement.constants';
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
export function addOrderForSettlement(
  bucket: Buckets,
  order: {
    paymentMethod: string | null;
    totalCents: number;
    advanceCents: number;
    pay: string;
    shopId?: string;
    resellerShopId?: string | null;
    resellerMarginCents?: number;
  },
  beneficiaryShopId?: string,
  catalog?: MethodCatalog,
): void {
  if (order.resellerShopId) {
    if (beneficiaryShopId === order.resellerShopId) {
      addOrder(
        bucket,
        RESELLER_ONLINE_MARGIN.code,
        order.resellerMarginCents ?? 0,
        1,
      );
    } else {
      // The wholesaler carries processing on the entire online receipt.
      // The reseller receives their full margin without a second fee.
      addOrder(bucket, order.paymentMethod, order.totalCents, 1);
      if (
        order.paymentMethod &&
        catalog?.get(order.paymentMethod)?.gateway !== 'none' &&
        catalog?.has(order.paymentMethod)
      ) {
        bucket.resellerMarginCents += order.resellerMarginCents ?? 0;
        const processing = feeCents(
          order.totalCents,
          catalog.get(order.paymentMethod)!.feeBp,
        );
        bucket.processingShortfallCents += Math.max(
          0,
          processing - (order.totalCents - (order.resellerMarginCents ?? 0)),
        );
      }
    }
    return;
  }
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
 * How a reseller's margin on one order is paid out, and when - or null when
 * it is not payable yet.
 *
 * Paid online, the platform is already holding the margin: it is paid out
 * under the method that collected it, in the cycle the parcel arrived in.
 *
 * Collected by the supplier - cash on delivery, a direct transfer - the
 * margin is in the supplier's hands, and the platform only has it to pay
 * once the supplier has handed it in with their service fee
 * (`duesPaidAt`, see ServiceFeesService). It joins the cycle that happened
 * in, since that is when the money became the platform's to pay.
 */
export function resellerMarginPayout(
  order: {
    paymentMethod: string | null;
    resellerShopId?: string | null;
    resellerMarginCents?: number;
    duesPaidAt: Date | null;
    deliveredAt: Date | null;
    handedOverAt: Date | null;
    deliveryMode: 'manual' | 'carrybee' | null;
  },
  catalog: MethodCatalog,
): { method: string; cents: number; at: Date } | null {
  if (!order.resellerShopId || !order.resellerMarginCents) return null;
  const method = order.paymentMethod
    ? catalog.get(order.paymentMethod)
    : undefined;
  if (method && method.gateway !== 'none') {
    const at = settledOnOf(order);
    return at
      ? {
          method: RESELLER_ONLINE_MARGIN.code,
          cents: order.resellerMarginCents,
          at,
        }
      : null;
  }
  return order.duesPaidAt
    ? {
        method: RESELLER_CASH_MARGIN.code,
        cents: order.resellerMarginCents,
        at: order.duesPaidAt,
      }
    : null;
}

/** The columns `shareOf` reads off an order. */
interface SettledOrder {
  shopId: string;
  paymentMethod: string | null;
  totalCents: number;
  advanceCents: number;
  pay: string;
  resellerShopId: string | null;
  resellerMarginCents: number;
  deliveredAt: Date | null;
  handedOverAt: Date | null;
  deliveryMode: 'manual' | 'carrybee' | null;
  duesPaidAt: Date | null;
}

/**
 * What one order contributes to one shop's payouts: which cycle (by `at`)
 * and how it is counted. Usually a single entry, and none while the order is
 * undelivered - that money is nobody's payout yet, and joins the cycle the
 * parcel arrives in, whenever that turns out to be.
 *
 * The one definition the seller's screen, the operator's table and the
 * record-a-payout path all bucket by.
 */
export function shareOf(
  order: SettledOrder,
  shopId: string,
  catalog: MethodCatalog,
): { at: Date; add: (bucket: Buckets) => void }[] {
  if (order.resellerShopId && order.resellerShopId === shopId) {
    const margin = resellerMarginPayout(order, catalog);
    if (!margin) return [];
    return [
      {
        at: margin.at,
        add: (bucket) => addOrder(bucket, margin.method, margin.cents, 1),
      },
    ];
  }
  if (order.shopId !== shopId) return [];
  const arrived = settledOnOf(order);
  if (!arrived) return [];
  return [
    {
      at: arrived,
      add: (bucket) => addOrderForSettlement(bucket, order, shopId, catalog),
    },
  ];
}

/**
 * What a shop is still owed from cycles that have closed, oldest first.
 *
 * This is the figure the minimum payout is measured against - not any one
 * cycle's amount. A shop that earns a little every month is not owed "less
 * than the minimum" for ever: its unpaid cycles add up, and the month they
 * reach the minimum together is the month all of them are paid.
 */
export function owedFromClosed(
  cycles: Map<string, Buckets>,
  paid: { has(period: string): boolean },
  catalog: MethodCatalog,
  before: string = currentPeriod(),
): { cents: number; periods: { period: string; cents: number }[] } {
  const periods = [...cycles]
    .filter(([period]) => period < before && !paid.has(period))
    .map(([period, buckets]) => ({
      period,
      cents: payoutCents(classify(buckets, catalog)),
    }))
    .filter((c) => c.cents > 0)
    .sort((a, b) => a.period.localeCompare(b.period));
  return { cents: periods.reduce((sum, c) => sum + c.cents, 0), periods };
}

/** Owed something, but not yet enough to send. */
export function belowMinimum(owedCents: number): boolean {
  return owedCents > 0 && owedCents < SETTLEMENT_MIN_PAYOUT_CENTS;
}

/** A combined bank transfer is displayed once, on its primary cycle. */
function paidCarryOf(period: string, rows: Iterable<SettlementRow>) {
  let paidCarriedCents = 0;
  let paidCarriedDuesCents = 0;
  for (const row of rows) {
    if (row.period !== period && row.paidWithPeriod === period) {
      paidCarriedCents += row.payoutCents;
      paidCarriedDuesCents += row.duesDeductedCents ?? 0;
    }
  }
  return { paidCarriedCents, paidCarriedDuesCents };
}

/** A paid payment link, reduced to what a payout cycle needs of it. */
export interface PaidLink {
  shopId: string;
  amountCents: number;
  paymentMethod: string | null;
  paidAt: Date;
}

/**
 * Count one paid payment link into a cycle. It is a sale like any other, so
 * it joins the count and the total, under the fee of the method that
 * collected it.
 */
export function addPaidLink(
  bucket: Buckets,
  link: Pick<PaidLink, 'amountCents' | 'paymentMethod'>,
): void {
  addOrder(bucket, link.paymentMethod, link.amountCents, 1);
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
 *
 * Two rules sit on top of the per-cycle arithmetic:
 *
 *   - **The minimum.** A shop owed less than the minimum payout across all
 *     its closed cycles is not sent a transfer; those cycles are 'held' and
 *     ride along with the first later payout that takes the total over it.
 *   - **What the shop owes back.** A payout is sent net of the shop's
 *     service-fee balance (fees on cash orders, reseller margins it is
 *     holding). The amount kept back is written to that ledger as a payment
 *     and remembered on the cycle, so both statements agree.
 */
@Injectable()
export class SettlementsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly shops: ShopsService,
    private readonly methods: PaymentMethodsService,
    // The two modules lean on each other - payouts are netted against the
    // fee balance, and the fee engine reads the payment-method catalogue -
    // so this side of the pair is resolved lazily.
    @Optional()
    @Inject(forwardRef(() => ServiceFeesService))
    private readonly serviceFees?: ServiceFeesService,
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
    const [catalog, methodViews, banner] = await Promise.all([
      this.methods.byCode(),
      this.methods.listEnabled(),
      this.methods.getBanner(),
    ]);
    const { byPeriod, paidByPeriod } = await this.cyclesFor(shopId, catalog);
    const owed = owedFromClosed(byPeriod, paidByPeriod, catalog);
    const dues = (await this.duesFor([shopId])).get(shopId) ?? 0;
    const netOwed = Math.max(0, owed.cents - Math.max(0, dues));
    const held = belowMinimum(netOwed);
    const heldPeriods = new Set(held ? owed.periods.map((c) => c.period) : []);

    // Continuous month range from the first order to today, so quiet months
    // still appear (as "nothing to settle") instead of silently vanishing.
    const months: SettlementMonthResponse[] = [];
    const allPeriods = [...byPeriod.keys(), ...paidByPeriod.keys()];
    if (allPeriods.length) {
      const first = allPeriods.sort()[0];
      for (let p = currentPeriod(); p >= first; p = previousPeriod(p)) {
        months.push(
          this.buildMonth(p, byPeriod.get(p), paidByPeriod.get(p), catalog, {
            held: heldPeriods.has(p),
            ...paidCarryOf(p, paidByPeriod.values()),
            carriedCents: paidByPeriod.has(p)
              ? 0
              : owed.periods
                  .filter((c) => c.period < p)
                  .reduce((sum, c) => sum + c.cents, 0),
            duesCents: dues,
          }),
        );
      }
    }
    return {
      methods: methodViews,
      banner,
      months,
      minPayout: centsToDollars(SETTLEMENT_MIN_PAYOUT_CENTS),
      heldAmount: held ? centsToDollars(netOwed) : undefined,
    };
  }

  /**
   * One shop's money, cycle by cycle: what has been delivered into each, and
   * which have been paid out. The single read the seller's screen, the
   * operator's row and the record-a-payout path all work from, so they
   * cannot disagree about which cycle an order's money belongs to.
   */
  private async cyclesFor(
    shopId: string,
    catalog: MethodCatalog,
    db: DrizzleDB = this.db,
  ): Promise<{
    byPeriod: Map<string, Buckets>;
    paidByPeriod: Map<string, SettlementRow>;
  }> {
    const [linkRows, rows, paidRows] = await Promise.all([
      this.paidLinks(eq(paymentLinks.shopId, shopId), db),
      db.query.orders.findMany({
        where: and(
          or(eq(orders.shopId, shopId), eq(orders.resellerShopId, shopId)),
          or(eq(orders.pay, 'Paid'), isNotNull(orders.advancePaidAt)),
          sql`not exists (select 1 from trade_disputes as dispute where dispute.order_id = ${orders.id} and dispute.status <> 'resolved')`,
          ne(orders.status, 'Cancelled'),
          ne(orders.pay, 'Refunded'),
          // An exchange replacement carries the money of the order it
          // replaces, which has already been settled. Paying out on both
          // would pay the shop twice for one sale.
          isNull(orders.exchangedFromOrderId),
        ),
        columns: {
          shopId: true,
          resellerShopId: true,
          resellerMarginCents: true,
          totalCents: true,
          paymentMethod: true,
          advanceCents: true,
          pay: true,
          deliveredAt: true,
          handedOverAt: true,
          deliveryMode: true,
          duesPaidAt: true,
        },
      }),
      db.query.settlements.findMany({
        where: eq(settlements.shopId, shopId),
      }),
    ]);

    const byPeriod = new Map<string, Buckets>();
    for (const r of rows) {
      for (const entry of shareOf(r, shopId, catalog)) {
        const period = periodOf(entry.at);
        const b = byPeriod.get(period) ?? emptyBuckets();
        entry.add(b);
        byPeriod.set(period, b);
      }
    }
    for (const link of linkRows) {
      const period = periodOf(link.paidAt);
      const b = byPeriod.get(period) ?? emptyBuckets();
      addPaidLink(b, link);
      byPeriod.set(period, b);
    }
    return {
      byPeriod,
      paidByPeriod: new Map(paidRows.map((s) => [s.period, s])),
    };
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
    const [catalog, linkRows, rows, paidRows] = await Promise.all([
      this.methods.byCode(),
      this.paidLinks(),
      this.db.query.orders.findMany({
        where: and(
          or(eq(orders.pay, 'Paid'), isNotNull(orders.advancePaidAt)),
          sql`not exists (select 1 from trade_disputes as dispute where dispute.order_id = ${orders.id} and dispute.status <> 'resolved')`,
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
          resellerShopId: true,
          resellerMarginCents: true,
          totalCents: true,
          advanceCents: true,
          pay: true,
          deliveredAt: true,
          handedOverAt: true,
          deliveryMode: true,
          duesPaidAt: true,
        },
      }),
      this.db.query.settlements.findMany(),
    ]);

    // cycle -> shop -> what arrived in it
    const byPeriod = new Map<string, Map<string, Buckets>>();
    for (const r of rows) {
      // An order can pay two shops - its supplier and, when it was resold,
      // the reseller - and not necessarily in the same cycle.
      const parties = r.resellerShopId
        ? [r.shopId, r.resellerShopId]
        : [r.shopId];
      for (const party of parties) {
        for (const entry of shareOf(r, party, catalog)) {
          const period = periodOf(entry.at);
          const shops = byPeriod.get(period) ?? new Map<string, Buckets>();
          const b = shops.get(party) ?? emptyBuckets();
          entry.add(b);
          shops.set(party, b);
          byPeriod.set(period, shops);
        }
      }
    }
    for (const link of linkRows) {
      const period = periodOf(link.paidAt);
      const shops = byPeriod.get(period) ?? new Map<string, Buckets>();
      const b = shops.get(link.shopId) ?? emptyBuckets();
      addPaidLink(b, link);
      shops.set(link.shopId, b);
      byPeriod.set(period, shops);
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

    // What each of these shops is owed across every closed cycle - the
    // figure the minimum is measured against - and what it owes back.
    const owedByShop = new Map(
      shopIds.map((shopId) => {
        const cycles = new Map<string, Buckets>();
        const paid = new Set<string>();
        for (const [p, shopsInCycle] of byPeriod) {
          const b = shopsInCycle.get(shopId);
          if (b) cycles.set(p, b);
        }
        for (const [p, shopsInCycle] of paidByPeriod) {
          if (shopsInCycle.has(shopId)) paid.add(p);
        }
        return [shopId, owedFromClosed(cycles, paid, catalog)] as const;
      }),
    );
    const dues = await this.duesFor(shopIds);

    const built: PlatformSettlementRowResponse[] = shopRows
      .map((s) => {
        const owed = owedByShop.get(s.id) ?? { cents: 0, periods: [] };
        return {
          shopId: s.id,
          shopName: s.name,
          shopHandle: s.handle,
          currency: s.currency,
          ...this.buildMonth(
            selected,
            liveShops.get(s.id),
            paidShops.get(s.id),
            catalog,
            {
              held:
                belowMinimum(
                  Math.max(0, owed.cents - Math.max(0, dues.get(s.id) ?? 0)),
                ) && owed.periods.some((c) => c.period === selected),
              carriedCents: owed.periods
                .filter((c) => c.period < selected)
                .reduce((sum, c) => sum + c.cents, 0),
              duesCents: dues.get(s.id) ?? 0,
              ...paidCarryOf(
                selected,
                paidRows.filter((row) => row.shopId === s.id),
              ),
            },
          ),
        };
      })
      // Biggest payouts first - the ones the operator needs to act on.
      .sort((a, b) => b.payout - a.payout || b.total - a.total);

    const totals = new Map<string, PlatformSettlementTotalResponse>();
    for (const r of built) {
      const t = totals.get(r.currency) ?? {
        currency: r.currency,
        pendingPayout: 0,
        paidPayout: 0,
      };
      if (r.status === 'paid') t.paidPayout += r.transfer;
      else t.pendingPayout += r.transfer;
      // Money delivered into a cycle since it was paid out is still owed.
      if (r.unrecorded) t.pendingPayout += r.additionalTransfer ?? r.unrecorded;
      totals.set(r.currency, t);
    }

    return {
      period: selected,
      periods,
      unsettled,
      rows: built,
      totals: [...totals.values()],
      minPayout: centsToDollars(SETTLEMENT_MIN_PAYOUT_CENTS),
    };
  }

  /**
   * Platform admin: record (or undo) one shop's payout.
   *
   * Recording a cycle settles everything the shop is owed up to it: earlier
   * closed cycles that were held under the minimum are paid in the same
   * transfer and written in the same step, each with its own snapshot. What
   * the shop owes on its service-fee balance is kept back from the total,
   * so the amount to send is the two apart - the row says so before the
   * operator confirms, and the snapshot remembers it afterwards.
   */
  async decide(
    shopId: string,
    period: string,
    paid: boolean,
    note?: string,
    proof?: { data: string; name?: string },
    recordedBy?: string,
  ): Promise<PlatformSettlementRowResponse> {
    const shop = await this.shops.requireById(shopId);
    const catalog = await this.methods.byCode();
    await this.db.transaction(async (tx) => {
      // All payout writers and the fee reconciler lock the same shop. Read
      // balances after the lock, so concurrent confirmations cannot pay twice.
      const [locked] = await tx
        .select({ id: shops.id })
        .from(shops)
        .where(eq(shops.id, shopId))
        .for('update');
      if (!locked) throw new NotFoundException('Shop not found');
      const db = tx as unknown as DrizzleDB;
      if (!paid) {
        const existing = await tx.query.settlements.findFirst({
          where: and(
            eq(settlements.shopId, shopId),
            eq(settlements.period, period),
          ),
        });
        if (!existing)
          throw new NotFoundException('This month has not been marked paid.');
        if (existing.paidWithPeriod && existing.paidWithPeriod !== period) {
          throw new BadRequestException(
            'This cycle was paid with ' +
              existing.paidWithPeriod +
              '. Undo that combined transfer instead.',
          );
        }
        await tx
          .delete(settlements)
          .where(
            and(
              eq(settlements.shopId, shopId),
              or(
                eq(settlements.period, period),
                eq(settlements.paidWithPeriod, period),
              ),
            ),
          );
        await tx
          .delete(serviceFeePayments)
          .where(
            and(
              eq(serviceFeePayments.shopId, shopId),
              eq(serviceFeePayments.payoutPeriod, period),
            ),
          );
        return;
      }
      const { byPeriod, paidByPeriod } = await this.cyclesFor(
        shopId,
        catalog,
        db,
      );
      const existing = paidByPeriod.get(period);
      if (existing?.paidWithPeriod && existing.paidWithPeriod !== period) {
        throw new BadRequestException(
          'This cycle was paid with ' +
            existing.paidWithPeriod +
            '. Review that combined transfer first.',
        );
      }
      const core = classify(byPeriod.get(period) ?? emptyBuckets(), catalog);
      const payout = payoutCents(core);
      if (payout <= 0)
        throw new BadRequestException(
          'No online payments this month - there is nothing to pay out.',
        );
      const carried = owedFromClosed(
        byPeriod,
        paidByPeriod,
        catalog,
      ).periods.filter((c) => c.period < period);
      const outstanding = await serviceFeeBalanceCents(db, shopId);
      const plan = planPayout({
        payoutCents: payout,
        previousPayoutCents: existing?.payoutCents,
        previousDuesCents: existing?.duesDeductedCents ?? 0,
        carried,
        outstandingCents: outstanding,
      });
      if (plan.availableCents <= 0) return; // A repeated confirmation is idempotent.
      if (belowMinimum(plan.transferCents)) {
        throw new BadRequestException({
          error: 'BelowMinimumPayout',
          message:
            'The net transfer is ' +
            taka(plan.transferCents) +
            ', under the ' +
            taka(SETTLEMENT_MIN_PAYOUT_CENTS) +
            ' minimum. It carries forward to the next payout.',
        });
      }
      if (plan.transferCents > 0 && !proof?.data) {
        throw new BadRequestException({
          error: 'PayoutProofRequired',
          message:
            'Attach the receipt for this transfer - the seller is shown it as the proof they were paid.',
        });
      }
      const at = new Date();
      const stamp = proof?.data
        ? {
            data: proof.data,
            name: proof.name?.trim() || undefined,
            at: at.toISOString(),
          }
        : null;
      const cleanNote = note?.trim() || null;
      if (plan.deductionCents > 0) {
        await tx.insert(serviceFeePayments).values({
          shopId,
          amountCents: plan.deductionCents,
          via: 'payout',
          payoutPeriod: period,
          note: 'Kept back from the ' + period + ' payout',
          recordedBy: recordedBy ?? null,
          paidAt: at,
        });
      }
      for (const c of plan.carried) {
        const snapshot = snapshotOf(
          classify(byPeriod.get(c.period)!, catalog),
          catalog,
        );
        await tx
          .insert(settlements)
          .values({
            shopId,
            period: c.period,
            ...snapshot,
            duesDeductedCents: c.duesCents,
            paidWithPeriod: period,
            note: cleanNote,
            proofs:
              stamp && c.transferCents > 0
                ? [{ ...stamp, payoutCents: c.transferCents }]
                : null,
            paidAt: at,
          })
          .onConflictDoNothing({
            target: [settlements.shopId, settlements.period],
          });
      }
      const snapshot = {
        ...snapshotOf(core, catalog),
        duesDeductedCents: plan.currentDuesCents,
        paidWithPeriod: period,
        note: cleanNote,
        proofs: [
          ...(existing?.proofs ?? []),
          ...(stamp && plan.currentTransferCents > 0
            ? [{ ...stamp, payoutCents: plan.currentTransferCents }]
            : []),
        ] satisfies SettlementProof[],
        paidAt: at,
      };
      await tx
        .insert(settlements)
        .values({ shopId, period, ...snapshot })
        .onConflictDoUpdate({
          target: [settlements.shopId, settlements.period],
          set: snapshot,
        });
    });
    await this.serviceFees?.reconcile(shopId);
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
    const catalog = await this.methods.byCode();
    const [{ byPeriod, paidByPeriod }, dues] = await Promise.all([
      this.cyclesFor(shop.id, catalog),
      this.duesFor([shop.id]),
    ]);
    const owed = owedFromClosed(byPeriod, paidByPeriod, catalog);
    return {
      shopId: shop.id,
      shopName: shop.name,
      shopHandle: shop.handle,
      currency: shop.currency,
      ...this.buildMonth(
        period,
        byPeriod.get(period),
        paidByPeriod.get(period),
        catalog,
        {
          held:
            belowMinimum(owed.cents) &&
            owed.periods.some((c) => c.period === period),
          carriedCents: owed.periods
            .filter((c) => c.period < period)
            .reduce((sum, c) => sum + c.cents, 0),
          duesCents: dues.get(shop.id) ?? 0,
          ...paidCarryOf(period, paidByPeriod.values()),
        },
      ),
    };
  }

  /** What each shop owes on its service-fee balance right now, in paisa. */
  private async duesFor(shopIds: string[]): Promise<Map<string, number>> {
    if (!this.serviceFees || !shopIds.length) return new Map();
    return this.serviceFees.balancesFor(shopIds);
  }

  /**
   * Paid payment links, as the payout math wants them. They are money the
   * platform collected for a shop exactly as a prepaid order is, but with no
   * parcel to wait for - so a link joins the cycle it was *paid* in.
   */
  private async paidLinks(
    where?: SQL,
    db: DrizzleDB = this.db,
  ): Promise<PaidLink[]> {
    const rows = await db.query.paymentLinks.findMany({
      where: and(
        eq(paymentLinks.status, 'paid'),
        isNotNull(paymentLinks.paidAt),
        where,
      ),
      columns: {
        shopId: true,
        settledAmountCents: true,
        paymentMethod: true,
        paidAt: true,
      },
    });
    return rows.map((row) => ({
      ...row,
      amountCents: row.settledAmountCents ?? 0,
    })) as PaidLink[];
  }

  /** Assembles the API shape for one month from live buckets or a snapshot. */
  private buildMonth(
    period: string,
    live: Buckets | undefined,
    paid: SettlementRow | undefined,
    catalog: MethodCatalog,
    opts: {
      /** Under the minimum payout with everything else the shop is owed. */
      held?: boolean;
      /** Earlier closed cycles, unpaid, that this payout would carry. */
      carriedCents?: number;
      /** What the shop owes on its service-fee balance right now. */
      duesCents?: number;
      paidCarriedCents?: number;
      paidCarriedDuesCents?: number;
    } = {},
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
    const [coveredFrom, coveredTo] = monthRange(period);
    // What is - or was - actually sent. Paid: the cycle less what was kept
    // back. Unpaid: this cycle, plus the held ones it would carry, less what
    // the shop owes back today.
    const carried = paid
      ? (opts.paidCarriedCents ?? 0)
      : (opts.carriedCents ?? 0);
    const paidDues = paid
      ? (paid.duesDeductedCents ?? 0) + (opts.paidCarriedDuesCents ?? 0)
      : 0;
    const included = paid?.paidWithPeriod && paid.paidWithPeriod !== period;
    const duesNow = paid
      ? 0
      : Math.min(Math.max(0, opts.duesCents ?? 0), payout + carried);
    const transfer = paid
      ? included
        ? 0
        : Math.max(0, paid.payoutCents + carried - paidDues)
      : payout + carried - duesNow;
    const additionalTransfer =
      paid && unrecorded > 0
        ? Math.max(
            0,
            unrecorded +
              (opts.carriedCents ?? 0) -
              Math.max(0, opts.duesCents ?? 0),
          )
        : undefined;
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
      resellerMargin: centsToDollars(core.resellerMarginCents ?? 0),
      processingShortfall: centsToDollars(core.processingShortfallCents ?? 0),
      payout: centsToDollars(payout),
      carried: carried ? centsToDollars(carried) : undefined,
      duesOutstanding: duesNow ? centsToDollars(duesNow) : undefined,
      duesDeducted: paidDues ? centsToDollars(paidDues) : undefined,
      transfer: centsToDollars(transfer),
      additionalTransfer:
        additionalTransfer === undefined
          ? undefined
          : centsToDollars(additionalTransfer),
      unrecorded: unrecorded ? centsToDollars(unrecorded) : undefined,
      receipts: receiptsOf(paid?.proofs),
      status: statusOf(period, !!paid, payout, opts.held),
      windowFrom: window.from,
      windowTo: window.to,
      coveredFrom: coveredFrom.toISOString(),
      coveredTo: coveredTo.toISOString(),
      paidAt: paid?.paidAt.toISOString(),
      paidWithPeriod: paid?.paidWithPeriod ?? undefined,
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

/**
 * The amounts a payout snapshot freezes for one cycle. The mbank/card
 * columns predate dynamic methods; they are still filled (grouped by method
 * kind) so older tooling keeps reading sane numbers.
 */
function snapshotOf(core: MonthCore, catalog: MethodCatalog) {
  const kindCents = (kind: 'mbank' | 'card') =>
    core.online
      .filter((m) => catalog.get(m.code)?.kind === kind)
      .reduce((sum, m) => sum + m.cents, 0);
  return {
    ordersCount: core.ordersCount,
    totalCents: core.totalCents,
    codCents: core.codCents,
    mbankCents: kindCents('mbank'),
    cardCents: kindCents('card'),
    otherCents: core.otherCents,
    feeCents: totalFeeCents(core),
    resellerMarginCents: core.resellerMarginCents ?? 0,
    processingShortfallCents: core.processingShortfallCents ?? 0,
    payoutCents: payoutCents(core),
    mbankFeeBp: catalog.get('mbank')?.feeBp ?? MBANK_FEE_BP,
    cardFeeBp: catalog.get('card')?.feeBp ?? CARD_FEE_BP,
    breakdown: core.online,
  };
}

function taka(cents: number): string {
  return `৳${centsToDollars(cents).toLocaleString('en-US')}`;
}
