import { and, eq, gt, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { DrizzleDB } from '../../database/drizzle.types';
import {
  orders,
  paymentMethods,
  serviceFeePayments,
} from '../../database/schema';
import { orderDue } from './service-fee-core';

/**
 * Which orders can owe a service fee, and one shop's balance read straight
 * off them. Plain functions over a database handle rather than a provider,
 * so ShopsService can ask "does this shop still owe?" before deleting it
 * without importing ServiceFeesModule - which itself imports ShopsModule.
 */

export const FEE_COLUMNS = {
  id: true,
  shopId: true,
  reference: true,
  customerName: true,
  placedAt: true,
  deliveredAt: true,
  handedOverAt: true,
  totalCents: true,
  advanceCents: true,
  paymentMethod: true,
  platformFeeBp: true,
  resellerShopId: true,
  resellerMarginCents: true,
  duesPaidAt: true,
} as const;

/**
 * Orders that can owe a fee: delivered, with the money in the seller's
 * hands. How much - if anything - is the core's call, since it depends on
 * the payment method; this only narrows the read.
 *
 * The same exclusions a payout makes apply in reverse: a disputed order is
 * nobody's settled money yet, and an exchange's replacement carries the
 * money of the order it replaced, which has already been charged.
 */
export function owingOrders() {
  return and(
    inArray(orders.status, ['Delivered', 'Exchanged']),
    eq(orders.pay, 'Paid'),
    isNotNull(orders.paymentMethod),
    isNull(orders.exchangedFromOrderId),
    or(gt(orders.platformFeeBp, 0), gt(orders.resellerMarginCents, 0)),
    sql`not exists (select 1 from trade_disputes as dispute where dispute.order_id = ${orders.id} and dispute.status <> 'resolved')`,
  );
}

/** What a shop owes right now, in paisa; negative is credit in hand. */
export async function serviceFeeBalanceCents(
  db: DrizzleDB,
  shopId: string,
): Promise<number> {
  const [methods, rows, [paid]] = await Promise.all([
    db
      .select({ code: paymentMethods.code, gateway: paymentMethods.gateway })
      .from(paymentMethods),
    db.query.orders.findMany({
      where: and(eq(orders.shopId, shopId), owingOrders()),
      columns: FEE_COLUMNS,
    }),
    db
      .select({
        cents:
          sql<number>`coalesce(sum(${serviceFeePayments.amountCents}), 0)`.mapWith(
            Number,
          ),
      })
      .from(serviceFeePayments)
      .where(eq(serviceFeePayments.shopId, shopId)),
  ]);
  const catalog = new Map(methods.map((m) => [m.code, m]));
  const owed = rows.reduce(
    (sum, row) => sum + orderDue(row, catalog).dueCents,
    0,
  );
  return owed - paid.cents;
}
