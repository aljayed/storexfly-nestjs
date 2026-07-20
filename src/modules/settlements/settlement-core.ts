import type {
  PaymentMethodRow,
  SettlementMethodSnapshot,
  SettlementRow,
} from '../../database/schema';
import {
  CARD_FEE_BP,
  MBANK_FEE_BP,
  SETTLEMENT_WINDOW_END_DAY,
  SETTLEMENT_WINDOW_START_DAY,
  feeCents,
  type SettlementStatus,
} from './settlement.constants';

/**
 * Pure settlement math shared by SettlementsService and the delete-shop
 * flow in ShopsService (which cannot import SettlementsModule — it imports
 * ShopsModule). No providers, no DB: callers bring their own order rows and
 * payment-method catalog.
 */

/** Raw money buckets for one shop-month: per method code, all integer cents. */
export interface Buckets {
  ordersCount: number;
  totalCents: number;
  /** Orders recorded manually from the console — no payment method. */
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
  // Orders recorded manually from the console have no gateway — the seller
  // was paid directly, so like COD they carry no fee and no payout.
  if (!method) b.manualCents += cents;
  else b.byCode.set(method, (b.byCode.get(method) ?? 0) + cents);
}

/**
 * Splits raw per-code volume into COD / online / other using the method
 * catalog. Only *gateway-collected* methods (bKash etc.) are money the
 * platform actually holds — those carry the fee and the payout. Direct-
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

/* ── Calendar helpers (server-local months, matching the dashboard) ─ */

export function periodOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function currentPeriod(): string {
  return periodOf(new Date());
}

export function previousPeriod(period: string): string {
  const [y, m] = period.split('-').map(Number);
  return periodOf(new Date(y, m - 2, 1));
}

/** [start, end) instants of one "YYYY-MM" month in server-local time. */
export function monthRange(period: string): [Date, Date] {
  const [y, m] = period.split('-').map(Number);
  return [new Date(y, m - 1, 1), new Date(y, m, 1)];
}

/** The 15th–21st payout window in the month after the earnings month. */
export function windowOf(period: string): { from: string; to: string } {
  const [y, m] = period.split('-').map(Number);
  const next = new Date(y, m, 1); // first day of the following month
  const iso = (day: number) =>
    `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
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
  if (period >= currentPeriod()) return 'accruing';
  if (payout <= 0) return 'none';
  const { from, to } = windowOf(period);
  const today =
    periodOf(new Date()) + '-' + String(new Date().getDate()).padStart(2, '0');
  if (today < from) return 'scheduled';
  if (today <= to) return 'due';
  return 'overdue';
}

/** Every month from the first order to now, newest first. */
export function listPeriods(firstOrderAt: Date | undefined): string[] {
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

export { CARD_FEE_BP, MBANK_FEE_BP, feeCents };
