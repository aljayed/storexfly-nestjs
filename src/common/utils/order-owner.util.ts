import { and, eq, isNull, or, sql, type SQL } from 'drizzle-orm';
import { orders } from '../../database/schema';

/**
 * Which orders belong to one account.
 *
 * Two things count, and the order of them matters:
 *
 *   1. Orders placed *by* the account - `orders.user_id`. This is the real
 *      answer, and it survives the person changing their email, phone or
 *      username afterwards.
 *
 *   2. Guest orders left over from before they signed in, matched on the
 *      address they were placed with - but only while nothing else claims
 *      them. Without the `user_id IS NULL` guard, an order deliberately
 *      linked to one account would start showing up for whoever happened to
 *      hold that email address later, which is the exact failure this whole
 *      change exists to remove.
 *
 * Every "is this mine?" question routes through here - the profile's orders
 * and payments, verified-purchase reviews, the buyer's chat threads - so they
 * cannot drift apart into slightly different definitions of the same thing.
 */
export function ordersOwnedBy(
  accountId: string,
  email?: string | null,
): SQL<unknown> {
  const placedByAccount = eq(orders.userId, accountId);
  const address = email?.trim().toLowerCase();
  if (!address) return placedByAccount;

  return or(
    placedByAccount,
    and(isNull(orders.userId), sql`lower(${orders.email}) = ${address}`),
  ) as SQL<unknown>;
}
