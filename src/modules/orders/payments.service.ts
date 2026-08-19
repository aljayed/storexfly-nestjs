import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, lt } from 'drizzle-orm';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import {
  gatewayPayments,
  orders,
  paymentTransactions,
} from '../../database/schema';
import type { GatewayPaymentRow } from '../../database/schema';
import { BkashService } from '../gateways/bkash.service';
import {
  SslcommerzService,
  type SslcommerzCallbackBody,
} from '../gateways/sslcommerz.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { OrdersService } from './orders.service';

/** How long a payer gets to finish on the gateway before the session voids. */
const PENDING_TTL_MS = 45 * 60 * 1000;
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

export interface CallbackOutcome {
  /** Where to send the payer's browser. */
  redirectUrl: string;
}

/** Which of the three ways SSLCommerz can hand the payer back this is. */
export type SslcommerzReturn = 'success' | 'fail' | 'cancel';

/** How a settle attempt ended, in the words the result page speaks. */
type SettleStatus = 'success' | 'failed' | 'pending';

/** One charge the gateway told us about, normalised across providers. */
interface CapturedCharge {
  gatewayTxnId: string;
  valId?: string;
  amountCents: number;
  currency?: string;
  instrument?: string;
}

/**
 * The return leg of hosted checkout, for both gateways and both purposes.
 *
 * bKash redirects to /payments/bkash/callback with `paymentID` + `status`;
 * SSLCommerz form-POSTs to /payments/sslcommerz/{success,fail,cancel} with
 * `tran_id` + `val_id`, and independently POSTs the same news to
 * /payments/sslcommerz/ipn so a payer who closed the tab still gets what they
 * paid for.
 *
 * Two separate things happen when money lands, and keeping them apart is the
 * whole design:
 *
 *   1. **Record the charge.** Every settled transaction is written to
 *      `payment_transactions`, always, even when it is the second or third
 *      charge against a session that is already paid. Someone's card really
 *      was debited; that belongs in their history whatever it means for the
 *      order. Idempotent on the gateway's own transaction id, so a redirect
 *      and an IPN describing one charge collapse into one row.
 *
 *   2. **Apply the effect, once.** Confirming an order or granting credit is
 *      guarded on the *session* still being open, so however many times it
 *      was paid for, an order is confirmed once and a credit pack granted
 *      once.
 *
 * Nothing a browser (or an IPN) says is trusted on its own: bKash's execute
 * call and SSLCommerz's validator are what decide that money moved. A
 * callback that cannot be believed leaves the session open rather than
 * voiding it - the sweep is a safer last word than a forged one.
 */
@Injectable()
export class PaymentsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PaymentsService.name);
  private sweepTimer?: NodeJS.Timeout;

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly ordersService: OrdersService,
    private readonly subscriptions: SubscriptionsService,
    private readonly bkash: BkashService,
    private readonly sslcommerz: SslcommerzService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    this.sweepTimer = setInterval(() => {
      void this.expireStalePayments();
    }, SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.sweepTimer);
  }

  /* ── bKash ─────────────────────────────────────────────────────── */

  /**
   * bKash's hosted flow. Unlike SSLCommerz a session cannot be paid twice -
   * `execute` is only good once per `paymentID` - so a replayed callback is
   * just re-shown rather than re-recorded.
   */
  async handleBkashCallback(
    paymentId: string,
    status: string,
  ): Promise<CallbackOutcome> {
    const attempt = await this.attempt(paymentId);
    if (!attempt) {
      return { redirectUrl: this.resultUrl(null, { status: 'failed' }) };
    }

    const replayed = await this.replay(attempt);
    if (replayed) return replayed;

    if (status !== 'success') {
      await this.failAttempt(attempt, 'cancelled');
      return { redirectUrl: await this.outcome(attempt, 'cancelled') };
    }

    const executed = await this.bkash.executePayment(paymentId);
    // A short-paid or failed capture never marks anything paid.
    if (
      !executed.ok ||
      (executed.amountCents !== undefined &&
        executed.amountCents < attempt.amountCents)
    ) {
      this.logger.warn(
        `bKash execute rejected for ${paymentId}: ${executed.statusMessage ?? executed.transactionStatus ?? 'unknown'}`,
      );
      await this.failAttempt(attempt, 'failed');
      return { redirectUrl: await this.outcome(attempt, 'failed') };
    }

    const trxId = executed.trxId ?? paymentId;
    await this.settle(attempt, {
      gatewayTxnId: trxId,
      amountCents: executed.amountCents ?? attempt.amountCents,
      instrument: 'bKash',
    });
    return { redirectUrl: await this.outcome(attempt, 'success', trxId) };
  }

  /* ── SSLCommerz ────────────────────────────────────────────────── */

  /**
   * The payer's browser coming back from the hosted page. `outcome` is only
   * which of the three URLs it landed on - a claim, not a fact - so a success
   * is still put to the validator before anything is recorded or applied.
   *
   * Only the losing outcomes are signature-checked. A claimed success does
   * not need one: the validator asks SSLCommerz directly, and no browser can
   * talk its way past that. Demanding a signature there would only add a way
   * to strand a payment that actually went through.
   */
  async handleSslcommerzReturn(
    outcome: SslcommerzReturn,
    body: SslcommerzCallbackBody,
  ): Promise<CallbackOutcome> {
    const attempt = await this.attempt(body.tran_id ?? '', 'sslcommerz');
    if (!attempt) {
      return { redirectUrl: this.resultUrl(null, { status: 'failed' }) };
    }

    if (outcome === 'success') {
      // Deliberately ahead of the replay check: a second charge on a session
      // that is already paid is exactly the case this has to catch, and it is
      // the buyer's money whether or not it changes what they own.
      const settled = await this.settleSslcommerz(attempt, body.val_id ?? '');
      return {
        redirectUrl: await this.outcome(attempt, settled.status, settled.trxId),
      };
    }

    const replayed = await this.replay(attempt);
    if (replayed) return replayed;

    // This path cancels what the payer was buying, so a signature that is
    // present and wrong stops it: that callback did not come from SSLCommerz.
    // An unsigned one is let through - it is the payer's own browser on their
    // own purchase, and refusing it leaves them on a page that does nothing.
    if ((await this.sslcommerz.verifySignature(body)) === 'invalid') {
      this.logger.warn(
        `SSLCommerz ${outcome} callback for ${attempt.paymentId} failed its signature check`,
      );
      return { redirectUrl: await this.outcome(attempt, 'pending') };
    }
    const status = outcome === 'cancel' ? 'cancelled' : 'failed';
    await this.failAttempt(attempt, status);
    return { redirectUrl: await this.outcome(attempt, status) };
  }

  /**
   * Server-to-server notification. Carries the same news as the redirect and
   * exists for the payer who closed the tab: their money moved, so what they
   * bought has to land whether or not they came back. Always answered 200 -
   * SSLCommerz retries anything else, and a replay is a no-op here anyway.
   */
  async handleSslcommerzIpn(body: SslcommerzCallbackBody): Promise<void> {
    const attempt = await this.attempt(body.tran_id ?? '', 'sslcommerz');
    if (!attempt) return;

    // Unlike the redirect, an IPN is not a payer standing in front of us - it
    // is an anonymous POST, and it always carries a signature. No signature,
    // or a wrong one, and it is not SSLCommerz talking.
    if ((await this.sslcommerz.verifySignature(body)) !== 'valid') {
      this.logger.warn(
        `Ignoring an unverified SSLCommerz IPN for ${attempt.paymentId}`,
      );
      return;
    }

    const status = (body.status ?? '').toUpperCase();
    if (status === 'VALID' || status === 'VALIDATED') {
      await this.settleSslcommerz(attempt, body.val_id ?? '');
      return;
    }
    if (attempt.status !== 'created') return;
    if (status === 'FAILED') {
      await this.failAttempt(attempt, 'failed');
    } else if (status === 'CANCELLED' || status === 'EXPIRED') {
      await this.failAttempt(attempt, 'cancelled');
    }
    // Anything else ('UNATTEMPTED', a status we don't know) is not an
    // outcome - leave the session open for the sweep.
  }

  /**
   * Ask SSLCommerz what really happened and act on the answer. The validator
   * is the only statement about the money this trusts, and the amount and
   * transaction id it reports have to be the ones this session asked for.
   *
   * An unreachable gateway leaves the session open on purpose: the IPN or the
   * sweep will settle it, and voiding a possibly-paid purchase is the one
   * mistake there is no clean way back from.
   */
  private async settleSslcommerz(
    attempt: GatewayPaymentRow,
    valId: string,
  ): Promise<{ status: SettleStatus; trxId?: string }> {
    if (!valId) {
      this.logger.warn(
        `SSLCommerz reported success for ${attempt.paymentId} with no val_id to verify it`,
      );
      return { status: 'pending' };
    }
    const validation = await this.sslcommerz.validate(valId);
    if (validation.status === 'UNREACHABLE') return { status: 'pending' };

    const wrongTransaction =
      validation.tranId !== undefined &&
      validation.tranId !== attempt.paymentId;
    const shortPaid =
      validation.amountCents !== undefined &&
      validation.amountCents < attempt.amountCents;
    const wrongCurrency =
      validation.currency !== undefined && validation.currency !== 'BDT';

    if (!validation.ok || wrongTransaction || shortPaid || wrongCurrency) {
      this.logger.warn(
        `SSLCommerz validation rejected for ${attempt.paymentId}: ` +
          `${validation.status ?? 'unknown'} ${validation.reason ?? ''}` +
          `${wrongTransaction ? ' (tran_id mismatch)' : ''}` +
          `${shortPaid ? ' (short paid)' : ''}` +
          `${wrongCurrency ? ' (wrong currency)' : ''}`,
      );
      // Only a still-open session can be failed by this; a rejected replay
      // against an already-paid session changes nothing.
      if (attempt.status === 'created') {
        await this.failAttempt(attempt, 'failed');
      }
      return { status: 'failed' };
    }

    const trxId = validation.bankTranId ?? valId;
    await this.settle(attempt, {
      gatewayTxnId: trxId,
      valId,
      amountCents: validation.amountCents ?? attempt.amountCents,
      currency: validation.currency,
      instrument: validation.cardType,
    });
    return { status: 'success', trxId };
  }

  /* ── Recording, and applying once ──────────────────────────────── */

  /**
   * Record the charge, then apply what it bought if this session has not
   * already delivered. The two steps are independent on purpose - see the
   * class comment.
   */
  private async settle(
    attempt: GatewayPaymentRow,
    charge: CapturedCharge,
  ): Promise<void> {
    const transactionId = await this.recordTransaction(attempt, charge);

    // Claim the session. Whoever wins this update is the one that delivers;
    // everyone else has just recorded a charge and stops here.
    const [claimed] = await this.db
      .update(gatewayPayments)
      .set({ status: 'success', trxId: charge.gatewayTxnId })
      .where(
        and(
          eq(gatewayPayments.id, attempt.id),
          eq(gatewayPayments.status, 'created'),
        ),
      )
      .returning({ id: gatewayPayments.id });
    if (!claimed) {
      this.logger.warn(
        `Extra payment ${charge.gatewayTxnId} recorded against already-settled session ${attempt.paymentId} - money received beyond what was owed`,
      );
      return;
    }

    if (attempt.purpose === 'credit_pack') {
      await this.subscriptions.grantPurchasedCredit(attempt, {
        transactionId,
        gatewayTxnId: charge.gatewayTxnId,
      });
    } else if (attempt.orderId) {
      await this.ordersService.confirmGatewayPayment(attempt.orderId);
    }
  }

  /**
   * Write one charge to the ledger. Unique on (provider, gatewayTxnId), so
   * telling us twice about one charge is harmless while two real charges stay
   * two rows. Returns the row's id either way.
   */
  private async recordTransaction(
    attempt: GatewayPaymentRow,
    charge: CapturedCharge,
  ): Promise<string | null> {
    // Order payments reach a buyer's history through the order's email, the
    // same rule the Orders tab uses, so nothing is stamped here. A credit
    // pack has a known owner, and no order to reach them through.
    const userId =
      attempt.purpose === 'credit_pack' && attempt.shopId
        ? await this.subscriptions.ownerIdForShop(attempt.shopId)
        : null;

    const [inserted] = await this.db
      .insert(paymentTransactions)
      .values({
        gatewayPaymentId: attempt.id,
        purpose: attempt.purpose,
        orderId: attempt.orderId,
        shopId: attempt.shopId,
        userId,
        provider: attempt.provider,
        gatewayTxnId: charge.gatewayTxnId,
        valId: charge.valId ?? null,
        amountCents: charge.amountCents,
        currency: charge.currency ?? 'BDT',
        instrument: charge.instrument ?? null,
      })
      .onConflictDoNothing({
        target: [
          paymentTransactions.provider,
          paymentTransactions.gatewayTxnId,
        ],
      })
      .returning({ id: paymentTransactions.id });
    if (inserted) return inserted.id;

    // Already recorded - the same charge arriving by both the redirect and
    // the IPN. Hand back the existing row so the ledger still links to it.
    const existing = await this.db.query.paymentTransactions.findFirst({
      where: and(
        eq(paymentTransactions.provider, attempt.provider),
        eq(paymentTransactions.gatewayTxnId, charge.gatewayTxnId),
      ),
      columns: { id: true },
    });
    return existing?.id ?? null;
  }

  /* ── Shared ────────────────────────────────────────────────────── */

  /** The session this callback is about, if the gateway named a real one. */
  private async attempt(
    paymentId: string,
    provider?: string,
  ): Promise<GatewayPaymentRow | undefined> {
    if (!paymentId) return undefined;
    const row = await this.db.query.gatewayPayments.findFirst({
      where: eq(gatewayPayments.paymentId, paymentId),
    });
    // An id is only ever minted by one gateway, so a provider mismatch means
    // the callback is not describing the session it named.
    if (provider && row && row.provider !== provider) return undefined;
    return row;
  }

  /**
   * Re-show the result for a session that was already decided, so a back
   * button or a duplicate callback cannot re-run any of it.
   */
  private async replay(
    attempt: GatewayPaymentRow,
  ): Promise<CallbackOutcome | null> {
    if (attempt.status === 'created') return null;
    const status = attempt.status === 'success' ? 'success' : 'cancelled';
    return {
      redirectUrl: await this.outcome(
        attempt,
        status,
        attempt.trxId ?? undefined,
      ),
    };
  }

  /** Close a session nobody paid for, and unwind whatever it was holding. */
  private async failAttempt(
    attempt: GatewayPaymentRow,
    status: 'failed' | 'cancelled' | 'expired',
  ): Promise<void> {
    const [claimed] = await this.db
      .update(gatewayPayments)
      .set({ status })
      .where(
        and(
          eq(gatewayPayments.id, attempt.id),
          eq(gatewayPayments.status, 'created'),
        ),
      )
      .returning({ id: gatewayPayments.id });
    if (!claimed) return;
    // A credit pack holds nothing until it is paid for, so there is nothing
    // to give back; an order was created up front and has to be voided.
    if (attempt.purpose !== 'credit_pack' && attempt.orderId) {
      await this.ordersService.voidPendingOrder(attempt.orderId);
    }
  }

  /** Void sessions (and their orders) the payer abandoned on the gateway. */
  private async expireStalePayments(): Promise<void> {
    try {
      const stale = await this.db.query.gatewayPayments.findMany({
        where: and(
          eq(gatewayPayments.status, 'created'),
          lt(gatewayPayments.createdAt, new Date(Date.now() - PENDING_TTL_MS)),
        ),
        limit: 50,
      });
      for (const attempt of stale) {
        await this.failAttempt(attempt, 'expired');
      }
      if (stale.length) {
        this.logger.log(`Expired ${stale.length} stale gateway session(s)`);
      }
    } catch (err) {
      this.logger.error('Pending-payment sweep failed', err as Error);
    }
  }

  /* ── Where the payer lands ─────────────────────────────────────── */

  /**
   * The result page for this session. A buyer goes to the storefront's
   * payment result; a seller who just topped up goes back to their billing
   * page, which is where the new balance is.
   */
  private async outcome(
    attempt: GatewayPaymentRow,
    status: SettleStatus | 'cancelled',
    trx?: string,
  ): Promise<string> {
    if (attempt.purpose === 'credit_pack') {
      return this.billingUrl({
        credit: status,
        pack: attempt.packCode ?? '',
        amount: String(attempt.amountCents / 100),
        trx: trx ?? '',
      });
    }
    const order = attempt.orderId
      ? await this.db.query.orders.findFirst({
          where: eq(orders.id, attempt.orderId),
          with: { shop: { columns: { handle: true } } },
        })
      : undefined;
    const advanceCents = order?.advanceCents ?? 0;
    const dueCents =
      order && advanceCents > 0 ? order.totalCents - advanceCents : 0;
    return this.resultUrl(attempt, {
      status,
      ref: order?.reference ?? '',
      shop:
        (order as { shop?: { handle: string } } | undefined)?.shop?.handle ??
        '',
      total: order ? String(attempt.amountCents / 100) : '',
      due: dueCents > 0 ? String(dueCents / 100) : '',
      partial: dueCents > 0 ? '1' : '',
      trx: trx ?? '',
    });
  }

  private resultUrl(
    attempt: GatewayPaymentRow | null,
    params: Record<string, string>,
  ): string {
    return this.webUrl('/pay/result', {
      ...params,
      // Which gateway to name on the receipt line.
      via: attempt?.provider ?? '',
    });
  }

  private billingUrl(params: Record<string, string>): string {
    return this.webUrl('/admin/billing', params);
  }

  private webUrl(path: string, params: Record<string, string>): string {
    const webUrl = (
      this.config.get<string>('app.webUrl') ?? 'http://localhost:5173'
    ).replace(/\/$/, '');
    const query = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== ''),
    );
    return `${webUrl}${path}?${query.toString()}`;
  }
}
