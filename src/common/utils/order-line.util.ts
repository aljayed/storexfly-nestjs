/**
 * Order lines are not all products. Checkout writes the shipping fee and the
 * combo reconciliation as extra rows in `order_items` (both with a null
 * `productId`) so the line totals always sum to the order total - but neither
 * is something the buyer bought. Anything that summarises "what was ordered"
 * (list previews, chat snapshots, customer product history) must skip them.
 */

/** Name checkout gives the shipping line - see OrdersService.pushDeliveryLine. */
export const DELIVERY_LINE_NAME = 'Delivery charge';

export type OrderLineKind = 'product' | 'delivery' | 'discount';

type LineLike = { productId: string | null; name: string };

/**
 * Classify a stored line. Delivery is matched by name because the rows predate
 * any type column; every line carrying a product is a product by definition,
 * so only the synthetic (productId = null) rows are ever name-matched.
 */
export function orderLineKind(line: LineLike): OrderLineKind {
  if (line.productId) return 'product';
  if (line.name.trim().toLowerCase() === DELIVERY_LINE_NAME.toLowerCase()) {
    return 'delivery';
  }
  return 'discount';
}

export function isDeliveryLine(line: LineLike): boolean {
  return orderLineKind(line) === 'delivery';
}

/** The lines a buyer would call "my items" - no shipping, no discount rows. */
export function productLines<T extends LineLike>(lines: T[]): T[] {
  return lines.filter((l) => orderLineKind(l) === 'product');
}
