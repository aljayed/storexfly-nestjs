/**
 * Settlement economics, shared by the shop-admin and platform-admin views.
 *
 * Sellers receive their prepaid (online) revenue in monthly payouts: each
 * calendar month's earnings are settled by the platform between the 15th and
 * 21st of the following month. COD money never flows through the platform —
 * the seller collects it in cash — so it carries no fee and no payout.
 *
 * Fee rates are stored in basis points so fee math stays in integers. The
 * live rates are platform-configurable and live on the `platform_settings`
 * singleton (see FeesService); the constants below are only the defaults
 * used before that row exists.
 */
export const MBANK_FEE_BP = 300; // 3% maintenance charge (bKash, Nagad, Rocket)
export const CARD_FEE_BP = 450; // 4.5% SSLCommerz processing fee

export const SETTLEMENT_WINDOW_START_DAY = 15;
export const SETTLEMENT_WINDOW_END_DAY = 21;

export function feeCents(amountCents: number, basisPoints: number): number {
  return Math.round((amountCents * basisPoints) / 10_000);
}

/**
 * Lifecycle of one earnings month:
 *  - accruing:  the month is still running, totals keep growing
 *  - scheduled: month closed; payout window (15th–21st next month) not open yet
 *  - due:       today is inside the payout window and the payout is unpaid
 *  - overdue:   the window has passed and the payout is still unpaid
 *  - paid:      a platform operator recorded the payout
 *  - none:      month closed with no online revenue — nothing to pay out
 */
export type SettlementStatus =
  | 'accruing'
  | 'scheduled'
  | 'due'
  | 'overdue'
  | 'paid'
  | 'none';
