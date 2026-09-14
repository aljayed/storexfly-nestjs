import type { OrderRow } from '../../database/schema';
import {
  ORDER_DEADLINES,
  orderDeadline,
  type OrderDeadline,
} from './order-deadlines';

export const ORDER_WARNING_HOURS = 24;

/** Minimal projection: the home page never needs a buyer's contact details. */
export type SellerAttentionRow = Pick<
  OrderRow,
  | 'id'
  | 'reference'
  | 'shopId'
  | 'status'
  | 'pay'
  | 'placedAt'
  | 'confirmedAt'
  | 'handedOverAt'
> & { shopName: string };

export interface SellerUrgentOrder {
  id: string;
  reference: string;
  shopId: string;
  shopName: string;
  status: OrderRow['status'];
  kind: OrderDeadline['kind'];
  dueAt: string;
}

export interface SellerOrderAttention {
  generatedAt: string;
  warningHours: number;
  rules: typeof ORDER_DEADLINES;
  newOrders: number;
  dueSoon: number;
  overdue: number;
  shops: { id: string; name: string; newOrders: number }[];
  urgentOrders: SellerUrgentOrder[];
}

/**
 * Reuse the cancellation worker's exact deadline calculation. In particular,
 * handed-over and legacy orders must not acquire a new dispatch deadline,
 * and overlapping clocks count as one order, at the earliest deadline.
 * Keep every urgent reference so the home can reveal more without hiding
 * orders after an arbitrary preview limit.
 */
export function summarizeSellerOrders(
  rows: SellerAttentionRow[],
  now = new Date(),
): SellerOrderAttention {
  const summary: SellerOrderAttention = {
    generatedAt: now.toISOString(),
    warningHours: ORDER_WARNING_HOURS,
    rules: ORDER_DEADLINES,
    newOrders: 0,
    dueSoon: 0,
    overdue: 0,
    shops: [],
    urgentOrders: [],
  };
  const shopCounts = new Map<string, SellerOrderAttention['shops'][number]>();
  const warningEnd = now.getTime() + ORDER_WARNING_HOURS * 3600_000;

  for (const row of rows) {
    const deadline = orderDeadline(row);
    if (!deadline) continue;
    if (row.status === 'New') {
      summary.newOrders++;
      let shop = shopCounts.get(row.shopId);
      if (!shop) {
        shop = { id: row.shopId, name: row.shopName, newOrders: 0 };
        shopCounts.set(row.shopId, shop);
      }
      shop.newOrders++;
    }
    const dueAt = deadline.dueAt.getTime();
    if (dueAt > warningEnd) continue;
    if (dueAt <= now.getTime()) summary.overdue++;
    else summary.dueSoon++;
    summary.urgentOrders.push({
      id: row.id,
      reference: row.reference,
      shopId: row.shopId,
      shopName: row.shopName,
      status: row.status,
      kind: deadline.kind,
      dueAt: deadline.dueAt.toISOString(),
    });
  }
  summary.shops = [...shopCounts.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  summary.urgentOrders.sort(
    (a, b) =>
      a.dueAt.localeCompare(b.dueAt) ||
      a.shopId.localeCompare(b.shopId) ||
      a.id.localeCompare(b.id),
  );
  return summary;
}
