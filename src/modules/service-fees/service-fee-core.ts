import {
  SERVICE_FEE_DUE_LIMIT_CENTS,
  SERVICE_FEE_GRACE_MS,
  SERVICE_FEE_BP,
} from '../../common/constants/billing';
import type { PaymentMethodRow } from '../../database/schema';

/**
 * Pure service-fee math: what one order leaves a seller owing, how payments
 * are matched against orders, and where a balance stands against the limit.
 * No providers and no database, so the rules can be read - and tested - in
 * one place.
 */

/** The part of an order the fee math needs. */
export interface FeeOrder {
  id: string;
  totalCents: number;
  advanceCents: number;
  paymentMethod: string | null;
  platformFeeBp: number;
  resellerShopId: string | null;
  resellerMarginCents: number;
  duesPaidAt: Date | null;
}

export type MethodCatalog = Map<string, Pick<PaymentMethodRow, 'gateway'>>;

/** What one order leaves the seller owing the platform. */
export interface OrderDue {
  /** Money the seller collected themself rather than through a gateway. */
  collectedCents: number;
  /** The service fee on the seller's own share of that. */
  feeCents: number;
  /** A reseller's margin the seller is holding, owed in full. */
  marginCents: number;
  /** fee + margin. */
  dueCents: number;
}

const NOTHING: OrderDue = {
  collectedCents: 0,
  feeCents: 0,
  marginCents: 0,
  dueCents: 0,
};

/**
 * How much of an order's money never passed through the platform.
 *
 * A method with no gateway behind it - cash on delivery, a transfer to the
 * seller's own number - is collected by the seller in full. A gateway method
 * with an advance is the protected-COD track: the advance was paid online
 * (and has its fee taken at payout), the balance was collected at the door.
 * Anything else was paid online in full, and an order recorded by hand from
 * the console was never the platform's sale to charge for.
 */
export function sellerCollectedCents(
  order: Pick<FeeOrder, 'totalCents' | 'advanceCents' | 'paymentMethod'>,
  catalog: MethodCatalog,
): number {
  if (!order.paymentMethod) return 0;
  const method = catalog.get(order.paymentMethod);
  if (!method) return 0;
  if (method.gateway === 'none') return order.totalCents;
  if (order.advanceCents > 0) {
    return Math.max(0, order.totalCents - order.advanceCents);
  }
  return 0;
}

/**
 * Retail fees apply to the seller's own cash/direct collection. Trade shops
 * have a zero sales-fee snapshot and remit the full reseller margin they
 * collected. Gateway processing is charged to the supplier at settlement;
 * any amount its proceeds cannot cover becomes an outstanding balance.
 */
export function orderDue(order: FeeOrder, catalog: MethodCatalog): OrderDue {
  const collectedCents = sellerCollectedCents(order, catalog);
  if (collectedCents <= 0) {
    // A very large reseller markup can leave the supplier's own proceeds
    // too small to cover processing. The uncovered amount is owed by the
    // supplier; the reseller's full margin is still protected.
    const online =
      order.paymentMethod &&
      catalog.get(order.paymentMethod)?.gateway !== 'none' &&
      catalog.has(order.paymentMethod);
    const shortfall =
      online && order.resellerShopId
        ? Math.max(
            0,
            Math.round((order.totalCents * SERVICE_FEE_BP) / 10_000) -
              (order.totalCents - order.resellerMarginCents),
          )
        : 0;
    return shortfall > 0
      ? {
          collectedCents: 0,
          feeCents: shortfall,
          marginCents: 0,
          dueCents: shortfall,
        }
      : NOTHING;
  }
  const marginCents = order.resellerShopId
    ? Math.min(Math.max(0, order.resellerMarginCents), collectedCents)
    : 0;
  const feeCents = Math.round(
    ((collectedCents - marginCents) * order.platformFeeBp) / 10_000,
  );
  const dueCents = feeCents + marginCents;
  if (dueCents <= 0) return NOTHING;
  return { collectedCents, feeCents, marginCents, dueCents };
}

export interface Allocation {
  /** Orders a payment has now covered - to be stamped paid. */
  cover: string[];
  /** Orders stamped paid that the payments no longer reach. */
  uncover: string[];
  /** Everything owed less everything paid; negative is credit in hand. */
  balanceCents: number;
}

/**
 * Match what a shop has paid against what its orders owe, oldest first.
 *
 * The balance needs none of this - it is simply owed minus paid. What the
 * matching decides is *which* orders are settled, and that matters because
 * a reseller is only paid their margin once the supplier has handed it in.
 * Strictly first in, first out: a payment never skips an older order to
 * cover a smaller, newer one, so a reseller is never left waiting behind
 * sales that came after theirs.
 *
 * `orders` must be oldest first, and hold only orders that owe something.
 */
export function allocate(
  orders: { id: string; dueCents: number; paid: boolean }[],
  paidCents: number,
): Allocation {
  const owedCents = orders.reduce((sum, o) => sum + o.dueCents, 0);
  let left = paidCents;
  const cover: string[] = [];
  const uncover: string[] = [];
  let blocked = false;
  for (const order of orders) {
    const reached = !blocked && left >= order.dueCents;
    if (reached) left -= order.dueCents;
    else blocked = true;
    if (reached && !order.paid) cover.push(order.id);
    if (!reached && order.paid) uncover.push(order.id);
  }
  return { cover, uncover, balanceCents: owedCents - paidCents };
}

/**
 *  - clear:   nothing owed
 *  - open:    something owed, under the limit - no deadline yet
 *  - due:     over the limit, inside the days allowed to pay
 *  - overdue: over the limit and out of time - the shop is suspended
 */
export type FeeStanding = 'clear' | 'open' | 'due' | 'overdue';

export function isOverLimit(balanceCents: number): boolean {
  return balanceCents > SERVICE_FEE_DUE_LIMIT_CENTS;
}

export function payByOf(overSince: Date): Date {
  return new Date(overSince.getTime() + SERVICE_FEE_GRACE_MS);
}

export function standingOf(
  balanceCents: number,
  overSince: Date | null,
  suspended: boolean,
  now: Date = new Date(),
): FeeStanding {
  if (balanceCents <= 0) return 'clear';
  // A suspension holds until the balance is gone, not merely back under the
  // limit - so a shop that has part-paid is still shown as overdue.
  if (suspended) return 'overdue';
  if (!isOverLimit(balanceCents) || !overSince) return 'open';
  return now.getTime() > payByOf(overSince).getTime() ? 'overdue' : 'due';
}
