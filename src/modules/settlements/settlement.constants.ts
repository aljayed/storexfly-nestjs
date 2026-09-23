/**
 * Settlement economics, shared by the shop-admin and platform-admin views.
 *
 * Sellers are paid their prepaid (online) revenue once a month, between the
 * 15th and the 21st. What a payout covers is decided by *delivery*, not by
 * the date of sale: an order delivered before the 15th is in that month's
 * payout, and one delivered on the 15th or after waits for the next. Money is
 * paid out when the goods have reached the buyer, which is the point of the
 * cut-off - and it means a cycle runs from the 15th of one month to the 15th
 * of the next rather than along the calendar.
 *
 * COD money never flows through the platform - the seller collects it in cash
 * - so it carries no fee and no payout.
 *
 * Fee rates are stored in basis points so fee math stays in integers. The
 * live rates are platform-configurable per payment method (see
 * PaymentMethodsService); the constants below only seed the default
 * mobile-banking and card methods on a fresh database.
 */
export const MBANK_FEE_BP = 300; // 3% maintenance charge (bKash, Nagad, Rocket)
export const CARD_FEE_BP = 350; // 3.5% SSLCommerz processing fee

export const SETTLEMENT_WINDOW_START_DAY = 15;
export const SETTLEMENT_WINDOW_END_DAY = 21;
/**
 * The day a cycle closes. Deliveries before it are paid this month; the rest
 * are next month's. It is the same day the window opens - what is being paid
 * out is everything that had arrived by the morning the payouts start.
 */
export const SETTLEMENT_CUTOFF_DAY = SETTLEMENT_WINDOW_START_DAY;

export function feeCents(amountCents: number, basisPoints: number): number {
  return Math.round((amountCents * basisPoints) / 10_000);
}

/**
 * Lifecycle of one payout cycle:
 *  - accruing:  the cycle is still open - deliveries keep joining it
 *  - scheduled: the cycle has closed but its window has not opened yet. A
 *               cycle closes on the morning its window opens, so nothing
 *               reaches this any more; it stays for payouts recorded under
 *               the old calendar-month rule.
 *  - due:       today is inside the 15th-21st window and the payout is unpaid
 *  - overdue:   the window has passed and the payout is still unpaid
 *  - paid:      a platform operator recorded the payout
 *  - none:      the cycle closed with no online revenue - nothing to pay out
 */
export type SettlementStatus =
  | 'accruing'
  | 'scheduled'
  | 'due'
  | 'overdue'
  | 'paid'
  | 'none';
