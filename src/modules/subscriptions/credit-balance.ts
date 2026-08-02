import { and, eq, gte, ne, sql } from 'drizzle-orm';
import { orders, subscriptions } from '../../database/schema';
import type { DbExecutor } from '../../database/drizzle.types';

/**
 * A shop's sales-credit position.
 *
 * `used` is not a stored counter - it is the value of the shop's non-cancelled
 * orders since its meter started, so cancelling an order hands the allowance
 * straight back and nothing can drift out of sync with the orders table.
 *
 * `balance` is deliberately *not* clamped at zero here. The order that takes a
 * shop past its balance still completes (see `assertCreditAvailable`), so a
 * shop can sit slightly overdrawn; leaving the number signed is what makes the
 * next top-up repay that overdraft instead of forgiving it.
 */
export interface CreditPosition {
  grantedCents: number;
  usedCents: number;
  balanceCents: number;
}

/**
 * Read one shop's credit position, or null when it has none to enforce -
 * no billing record, on the post-paid track, or still on the free trial with
 * nothing ever bought. Runs on any executor, so a checkout can call it inside
 * the transaction that holds the shop lock.
 */
export async function creditPosition(
  db: DbExecutor,
  shopId: string,
): Promise<CreditPosition | null> {
  const sub = await db
    .select({
      billingMode: subscriptions.billingMode,
      grantedCents: subscriptions.creditGrantedCents,
      meterStartAt: subscriptions.meterStartAt,
    })
    .from(subscriptions)
    .where(eq(subscriptions.shopId, shopId))
    .limit(1);
  const row = sub[0];
  // Post-paid shops sell on trust and are billed afterwards; a shop that has
  // never bought credit is on the free trial, which has its own limits.
  if (!row || row.billingMode !== 'credits' || row.grantedCents <= 0) {
    return null;
  }
  const [sales] = await db
    .select({ total: sql<string>`coalesce(sum(${orders.totalCents}), 0)` })
    .from(orders)
    .where(
      and(
        eq(orders.shopId, shopId),
        ne(orders.status, 'Cancelled'),
        gte(orders.placedAt, row.meterStartAt),
      ),
    );
  const usedCents = Number(sales?.total ?? 0);
  return {
    grantedCents: row.grantedCents,
    usedCents,
    balanceCents: row.grantedCents - usedCents,
  };
}
