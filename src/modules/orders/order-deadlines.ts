import type { OrderRow } from '../../database/schema';
import type { CancelReason, OrderStatus } from '../../database/schema/enums';

/**
 * The clocks an order runs against.
 *
 * A shop that stops answering used to leave a buyer holding an order forever -
 * money gone on a prepaid one, and no way to tell a slow seller from an absent
 * one. These are the limits past which the platform stops waiting on the shop's
 * behalf and gives the buyer their position back.
 *
 * Every window is measured from an event the database records, not from
 * `updatedAt`, which moves for reasons that have nothing to do with progress.
 * Kept here rather than inline so the sweep, the API responses and the seller
 * console are all quoting one number - a countdown in the UI that disagrees
 * with the job that actually cancels is worse than no countdown.
 */
export const ORDER_DEADLINES = {
  /** 'New' → the seller has this long to accept, measured from `placedAt`. */
  confirmHours: 72,
  /** Confirmed/Packed → this long to reach a courier, from `confirmedAt`. */
  dispatchDays: 7,
  /** Anything undelivered this long after `placedAt` is given up on. */
  deliverDays: 30,
  /**
   * How long the seller may move an order around by hand. Inside it they can
   * correct a mis-click in either direction; past it the pipeline only runs
   * forwards, so an old order cannot be quietly rewritten.
   */
  sellerEditDays: 15,
} as const;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Statuses that are over - nothing is owed and no clock applies. */
export const TERMINAL_STATUSES: readonly OrderStatus[] = [
  'Delivered',
  'Cancelled',
  'Exchanged',
];

/** Waiting on the seller to accept. */
const AWAITING_CONFIRM: readonly OrderStatus[] = ['New'];

/** Accepted, but not yet in a courier's hands. */
const AWAITING_DISPATCH: readonly OrderStatus[] = ['Confirmed', 'Packed'];

export interface OrderDeadline {
  /** Which clock is running. */
  kind: 'confirm' | 'dispatch' | 'deliver';
  /** When it runs out. */
  dueAt: Date;
  /** What the cancellation would be recorded as. */
  reason: CancelReason;
}

/**
 * The deadline an order is currently running against, or null when none is -
 * it is finished, or it is a pending payment that has its own expiry.
 *
 * Only ever one at a time, and it is the soonest that applies: a confirmed
 * order is running the dispatch clock, but if it was placed 29 days ago the
 * 30-day limit is what will actually reach it first.
 */
export function orderDeadline(order: {
  status: OrderStatus;
  pay: OrderRow['pay'];
  placedAt: Date;
  confirmedAt: Date | null;
  handedOverAt: Date | null;
}): OrderDeadline | null {
  if (TERMINAL_STATUSES.includes(order.status)) return null;
  // A gateway payment that never completed is swept by the payments service
  // on a much shorter fuse; it is not the shop's to answer for.
  if (order.pay === 'Pending') return null;

  const candidates: OrderDeadline[] = [
    {
      kind: 'deliver',
      dueAt: new Date(order.placedAt.getTime() + ORDER_DEADLINES.deliverDays * DAY),
      reason: 'auto_undelivered',
    },
  ];

  if (AWAITING_CONFIRM.includes(order.status)) {
    candidates.push({
      kind: 'confirm',
      dueAt: new Date(
        order.placedAt.getTime() + ORDER_DEADLINES.confirmHours * HOUR,
      ),
      reason: 'auto_unconfirmed',
    });
  } else if (AWAITING_DISPATCH.includes(order.status) && !order.handedOverAt) {
    // An order confirmed before this column existed has no start for the
    // dispatch clock. Falling back to `placedAt` would back-date it into an
    // instant cancellation on the first sweep, so those run on the 30-day
    // limit alone until the seller touches them.
    if (order.confirmedAt) {
      candidates.push({
        kind: 'dispatch',
        dueAt: new Date(
          order.confirmedAt.getTime() + ORDER_DEADLINES.dispatchDays * DAY,
        ),
        reason: 'auto_undispatched',
      });
    }
  }

  return candidates.reduce((soonest, c) =>
    c.dueAt < soonest.dueAt ? c : soonest,
  );
}

/**
 * Whether the seller may still reorder this order's status by hand.
 *
 * Deliberately generous inside the window and closed outside it: a shop
 * correcting today's mistake is normal, a shop rewriting last month's is the
 * thing this stops.
 */
export function withinSellerEditWindow(placedAt: Date, now = new Date()): boolean {
  return now.getTime() - placedAt.getTime() <= ORDER_DEADLINES.sellerEditDays * DAY;
}
