import type { CouponRow } from '../../database/schema';

type DiscountFields = Pick<CouponRow, 'percentOff' | 'amountOffCents'>;

/** What a coupon takes off, as the API describes it (major units, ৳). */
export interface CouponOff {
  /** A percentage coupon: 1-100. */
  percentOff?: number;
  /** A fixed-amount coupon, in ৳. */
  amountOff?: number;
}

export function couponOff(coupon: DiscountFields): CouponOff {
  return coupon.amountOffCents !== null
    ? { amountOff: coupon.amountOffCents / 100 }
    : { percentOff: coupon.percentOff ?? 0 };
}

/**
 * What a coupon takes off a payment of `amountCents`, in paisa.
 *
 * A percentage is rounded up to a whole taka so the price after the coupon is
 * a whole amount (৳599 at 75% → ৳450 off, pay ৳149). A fixed amount is
 * already whole taka and never takes off more than the price - a ৳2,000 code
 * on a ৳1,899 pack makes it free, it does not owe the seller ৳101.
 */
export function couponDiscountCents(
  amountCents: number,
  coupon: DiscountFields,
): number {
  if (coupon.amountOffCents !== null) {
    return Math.min(coupon.amountOffCents, amountCents);
  }
  return Math.ceil((amountCents * (coupon.percentOff ?? 0)) / 100 / 100) * 100;
}
