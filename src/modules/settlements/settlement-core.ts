import type {
  PaymentMethodRow,
  SettlementMethodSnapshot,
  SettlementRow,
} from '../../database/schema';
import {
  CARD_FEE_BP,
  MBANK_FEE_BP,
  SETTLEMENT_CUTOFF_DAY,
  SETTLEMENT_WINDOW_END_DAY,
  SETTLEMENT_WINDOW_START_DAY,
  feeCents,
  type SettlementStatus,
} from './settlement.constants';
import { zonedParts, zonedTime } from '../../common/utils/report-window.util';

/**
 * Pure settlement math shared by SettlementsService and the delete-shop
 * flow in ShopsService (which cannot import SettlementsModule - it imports
 * ShopsModule). No providers, no DB: callers bring their own order rows and
 * payment-method catalog.
 */

/** Raw money buckets for one shop-month: per method code, all integer cents. */
export interface Buckets {
  ordersCount: number;
  totalCents: number;
  /** Orders recorded manually from the console - no payment method. */
  manualCents: number;
  byCode: Map<string, number>;
}

/** A month classified against the payment-method catalog. */
export interface MonthCore {
  ordersCount: number;
  totalCents: number;
  codCents: number;
  otherCents: number;
  /** Online (fee-carrying) methods, each with its fee applied. */
  online: SettlementMethodSnapshot[];
}

export type MethodCatalog = Map<string, PaymentMethodRow>;

export function emptyBuckets(): Buckets {
  return { ordersCount: 0, totalCents: 0, manualCents: 0, byCode: new Map() };
}

export function addOrder(
  b: Buckets,
  method: string | null,
  cents: number,
  count: number,
): void {
  b.ordersCount += count;
  b.totalCents += cents;
  // Orders recorded manually from the console have no gateway - the seller
  // was paid directly, so like COD they carry no fee and no payout.
  if (!method) b.manualCents += cents;
  else b.byCode.set(method, (b.byCode.get(method) ?? 0) + cents);
}

/**
 * Splits raw per-code volume into COD / online / other using the method
 * catalog. Only *gateway-collected* methods (bKash etc.) are money the
 * platform actually holds - those carry the fee and the payout. Direct-
 * transfer methods (the seller's own wallet number) and codes the catalog
 * no longer knows join the no-fee/no-payout buckets, so money the platform
 * never touched is never "paid out".
 */
export function classify(b: Buckets, catalog: MethodCatalog): MonthCore {
  let codCents = 0;
  let otherCents = b.manualCents;
  const online: SettlementMethodSnapshot[] = [];
  for (const [code, cents] of b.byCode) {
    const method = catalog.get(code);
    if (!method) otherCents += cents;
    else if (method.kind === 'cod') codCents += cents;
    else if (method.gateway === 'none') otherCents += cents;
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
export function snapshotCore(paid: SettlementRow): MonthCore {
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

export function totalFeeCents(core: MonthCore): number {
  return core.online.reduce((sum, m) => sum + m.feeCents, 0);
}

export function payoutCents(core: MonthCore): number {
  return core.online.reduce((sum, m) => sum + m.cents - m.feeCents, 0);
}

/**
 * When one order becomes payable: the courier's delivery stamp, or the
 * handover for a manually delivered order, which nobody reports. Null means
 * it has not arrived, so it belongs to no cycle yet.
 *
 * SettlementsService keeps the same rule as SQL for the queries that filter
 * in the database; this is for the rows it buckets in memory.
 */
export function settledOnOf(order: {
  deliveredAt: Date | null;
  handedOverAt: Date | null;
  deliveryMode: 'manual' | 'carrybee' | null;
}): Date | null {
  if (order.deliveredAt) return order.deliveredAt;
  return order.deliveryMode === 'manual' ? order.handedOverAt : null;
}

/* ── The payout cycle ──────────────────────────────────────────────
   A cycle is named for the month it is paid out in, and runs from the 15th
   of the month before to the 15th of that month. So "2026-09" means
   everything delivered between 15 August and 14 September, paid between the
   15th and the 21st of September. Dates are read on the seller's calendar,
   not the server's: a delivery at 1am on the 15th in Dhaka is the 15th. */

/** Which cycle a delivery is paid out in. */
export function periodOf(d: Date): string {
  const p = zonedParts(d);
  const month = `${p.year}-${String(p.month).padStart(2, '0')}`;
  // On or after the cut-off it has missed this month's payout and waits.
  return p.day < SETTLEMENT_CUTOFF_DAY ? month : shiftPeriod(month, 1);
}

/** "YYYY-MM" plus a number of months, as plain calendar arithmetic. */
function shiftPeriod(period: string, months: number): string {
  const [y, m] = period.split('-').map(Number);
  const zero = y * 12 + (m - 1) + months;
  return `${Math.floor(zero / 12)}-${String((zero % 12) + 1).padStart(2, '0')}`;
}

/** The cycle now collecting deliveries. */
export function currentPeriod(): string {
  return periodOf(new Date());
}

export function previousPeriod(period: string): string {
  return shiftPeriod(period, -1);
}

/**
 * [start, end) instants of one cycle: the 15th of the month before, to the
 * 15th of the cycle's own month, both at midnight on the seller's calendar.
 */
export function monthRange(period: string): [Date, Date] {
  const [y, m] = period.split('-').map(Number);
  return [
    zonedTime(y, m - 1, SETTLEMENT_CUTOFF_DAY),
    zonedTime(y, m, SETTLEMENT_CUTOFF_DAY),
  ];
}

/** The 15th-21st payout window, in the cycle's own month. */
export function windowOf(period: string): { from: string; to: string } {
  const iso = (day: number) => `${period}-${String(day).padStart(2, '0')}`;
  return {
    from: iso(SETTLEMENT_WINDOW_START_DAY),
    to: iso(SETTLEMENT_WINDOW_END_DAY),
  };
}

export function statusOf(
  period: string,
  paid: boolean,
  payout: number,
): SettlementStatus {
  if (paid) return 'paid';
  // Nothing online arrived, so there is no transfer to make - true whether
  // or not the cycle has closed.
  if (payout <= 0) return 'none';
  // The cycle is still taking deliveries. It can be paid out all the same;
  // this only says that more may yet join it.
  if (period >= currentPeriod()) return 'accruing';
  const { from, to } = windowOf(period);
  // Today on the seller's calendar. Not derived from periodOf: that answers
  // "which payout is this delivery in", which after the 15th is next month.
  const now = zonedParts(new Date());
  const today = `${now.year}-${String(now.month).padStart(2, '0')}-${String(now.day).padStart(2, '0')}`;
  if (today < from) return 'scheduled';
  if (today <= to) return 'due';
  return 'overdue';
}

export { CARD_FEE_BP, MBANK_FEE_BP, feeCents };
