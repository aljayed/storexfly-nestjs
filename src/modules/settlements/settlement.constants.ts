import { SERVICE_FEE_BP } from '../../common/constants/billing';

/**
 * Settlement economics, shared by the shop-admin and platform-admin views.
 *
 * Sellers are paid their prepaid (online) revenue once a month, in the first
 * seven days of it. What a payout covers is decided by *delivery*, not by
 * the date of sale: everything delivered in one calendar month is paid in
 * the first week of the next. Money is paid out when the goods have reached
 * the buyer.
 *
 * Three things come off what the platform collected before it is sent:
 *
 *   - the service fee, which is each gateway method's rate;
 *   - on a reseller order, the reseller's margin - that part of the buyer's
 *     money was never the supplier's, and is paid to the reseller instead;
 *   - whatever the shop owes on money it collected itself (its service fee
 *     on cash orders, and reseller margins it is holding). The platform does
 *     not send a seller money with one hand and chase them for it with the
 *     other - see ServiceFeesService.
 *
 * A shop owed less than `SETTLEMENT_MIN_PAYOUT_CENTS` is not sent a transfer
 * that month: the amount is held and joins the next payout, until together
 * they reach the minimum.
 *
 * COD money never flows through the platform - the seller collects it in cash
 * - so it carries no payout. Retail COD service fees are owed by the seller; trade COD has no sales fee.
 *
 * Fee rates are stored in basis points so fee math stays in integers. The
 * live rates are platform-configurable per payment method (see
 * PaymentMethodsService); the constants below only seed the default
 * mobile-banking and card methods on a fresh database. Both are the
 * platform's service fee, which already includes the gateway's processing
 * charge - a seller sees one rate, whichever way the buyer paid, on orders
 * and payment links alike.
 */
export const MBANK_FEE_BP = SERVICE_FEE_BP;
export const CARD_FEE_BP = SERVICE_FEE_BP;

/**
 * A reseller's margin on an order the supplier collected in cash. It is not
 * a checkout method - no buyer ever picks it - but it is money the platform
 * comes to hold (the supplier pays it in with their service fee) and then
 * owes the reseller, so it is paid out like one, without a fee on the reseller’s earnings.
 */
export const RESELLER_CASH_MARGIN = {
  code: 'reseller-cash-margin',
  title: 'Reseller earnings (cash orders)',
  feeBp: 0,
} as const;

export const RESELLER_ONLINE_MARGIN = {
  code: 'reseller-online-margin',
  title: 'Reseller earnings (online orders)',
  feeBp: 0,
} as const;

export const SETTLEMENT_WINDOW_START_DAY = 1;
export const SETTLEMENT_WINDOW_END_DAY = 7;

/** The least a shop is sent in one payout, in paisa (৳2,000). */
export const SETTLEMENT_MIN_PAYOUT_CENTS = 200_000;

/**
 * Payouts used to run on a mid-month cycle: delivered from the 15th of one
 * month to the 14th of the next, paid between the 15th and the 21st. Cycles
 * already closed under that rule keep it - their payouts were recorded
 * against those dates, and re-reading them on the calendar-month rule would
 * move delivered orders out of a cycle that has been paid and into one that
 * has not.
 *
 * `MONTHLY_CYCLES_FROM` is the seller-calendar day the calendar-month rule
 * takes over: the day the last mid-month cycle closed. Deliveries from then
 * to the end of that month form one short bridging cycle
 * (`FIRST_MONTHLY_PERIOD`), paid in the first week of the next month like
 * every cycle after it.
 */
export const LEGACY_CUTOFF_DAY = 15;
export const LEGACY_WINDOW_END_DAY = 21;
export const MONTHLY_CYCLES_FROM = { year: 2026, month: 11, day: 15 } as const;
export const FIRST_MONTHLY_PERIOD = '2026-12';

export function feeCents(amountCents: number, basisPoints: number): number {
  return Math.round((amountCents * basisPoints) / 10_000);
}

/**
 * A payout is recorded when the operator actually transfers it, which they
 * may do at any point - including out of a cycle that is still open. The
 * statuses below describe where a cycle stands, not what is permitted.
 *
 * Lifecycle of one payout cycle:
 *  - accruing:  the cycle is still open - deliveries keep joining it
 *  - scheduled: the cycle has closed but its window has not opened yet. A
 *               cycle closes on the morning its window opens, so nothing
 *               reaches this any more; it stays for payouts recorded under
 *               the old calendar-month rule.
 *  - held:      the cycle has closed, but everything the shop is owed is
 *               still under the minimum payout - it carries forward
 *  - due:       today is inside the payout window and the payout is unpaid
 *  - overdue:   the window has passed and the payout is still unpaid
 *  - paid:      a platform operator recorded the payout
 *  - none:      the cycle closed with no online revenue - nothing to pay out
 */
export type SettlementStatus =
  | 'accruing'
  | 'scheduled'
  | 'held'
  | 'due'
  | 'overdue'
  | 'paid'
  | 'none';
