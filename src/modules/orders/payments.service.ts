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
import { gatewayPayments, orders } from '../../database/schema';
import type { GatewayPaymentRow } from '../../database/schema';
import { BkashService } from '../gateways/bkash.service';
import {
  SslcommerzService,
  type SslcommerzCallbackBody,
} from '../gateways/sslcommerz.service';
import { OrdersService } from './orders.service';

/** How long a buyer gets to finish paying on the gateway before it voids. */
const PENDING_TTL_MS = 45 * 60 * 1000;
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

export interface CallbackOutcome {
  /** Where to send the buyer's browser. */
  redirectUrl: string;
}

/** Which of the three ways SSLCommerz can hand the buyer back this is. */
export type SslcommerzReturn = 'success' | 'fail' | 'cancel';

/** How a settle attempt ended, in the words the result page speaks. */
type SettleStatus = 'success' | 'failed' | 'pending';

/**
 * The return leg of hosted checkout, for both gateways.
 *
 * bKash redirects the buyer to /payments/bkash/callback with `paymentID` +
 * `status`; SSLCommerz form-POSTs them to /payments/sslcommerz/{success,fail,
 * cancel} with `tran_id` + `val_id`, and independently POSTs the same news to
 * /payments/sslcommerz/ipn so a buyer who closed the tab still gets their
 * order. A confirmed payment captures the money, verifies the amount and
 * marks the order paid. Anything else voids the pending order so its stock
 * frees up immediately, and a background sweep does the same for buyers who
 * never came back at all.
 *
 * Nothing a browser (or an IPN) says is trusted on its own: bKash's execute
 * call and SSLCommerz's validator are what actually decide that money moved.
 * A callback that cannot be believed leaves the attempt open rather than
 * voiding it - the sweep is a safer last word than a forged one.
 */
@Injectable()
export class PaymentsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PaymentsService.name);
  private sweepTimer?: NodeJS.Timeout;

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly ordersService: OrdersService,
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

  async handleBkashCallback(
    paymentId: string,
    status: string,
  ): Promise<CallbackOutcome> {
    const attempt = await this.attempt(paymentId);
    if (!attempt) {
      return { redirectUrl: this.resultUrl({ status: 'failed' }) };
    }
    const context = await this.orderContext(attempt);

    // Replays of an already-decided attempt just re-show the result page.
    const settled = this.replay(attempt, context);
    if (settled) return settled;

    if (status !== 'success') {
      await this.failAttempt(attempt.id, attempt.orderId, 'cancelled');
      return {
        redirectUrl: this.resultUrl({ status: 'cancelled', ...context }),
      };
    }

    const executed = await this.bkash.executePayment(paymentId);
    // A short-paid or failed capture never marks the order paid.
    if (
      !executed.ok ||
      (executed.amountCents !== undefined &&
        executed.amountCents < attempt.amountCents)
    ) {
      this.logger.warn(
        `bKash execute rejected for ${paymentId}: ${executed.statusMessage ?? executed.transactionStatus ?? 'unknown'}`,
      );
      await this.failAttempt(attempt.id, attempt.orderId, 'failed');
      return { redirectUrl: this.resultUrl({ status: 'failed', ...context }) };
    }

    await this.claimSuccess(attempt, executed.trxId ?? null);
    return {
      redirectUrl: this.resultUrl({
        status: 'success',
        ...context,
        trx: executed.trxId ?? '',
      }),
    };
  }

  /* ── SSLCommerz ────────────────────────────────────────────────── */

  /**
   * The buyer's browser coming back from the hosted page. `outcome` is only
   * which of the three URLs it landed on - a claim, not a fact - so a success
   * is still put to the validator before anything is marked paid.
   *
   * Only the losing outcomes are signature-checked. A claimed success does
   * not need one: {@link settleSslcommerz} asks SSLCommerz directly, and no
   * browser can talk its way past that. Demanding a signature there would
   * only add a way to strand a payment that actually went through.
   */
  async handleSslcommerzReturn(
    outcome: SslcommerzReturn,
    body: SslcommerzCallbackBody,
  ): Promise<CallbackOutcome> {
    const attempt = await this.attempt(body.tran_id ?? '', 'sslcommerz');
    if (!attempt) {
      return { redirectUrl: this.resultUrl({ status: 'failed' }) };
    }
    const context = await this.orderContext(attempt);

    const replayed = this.replay(attempt, context);
    if (replayed) return replayed;

    if (outcome !== 'success') {
      // This path cancels the order, so a signature that is present and wrong
      // stops it: that callback did not come from SSLCommerz. An unsigned one
      // is let through - it is the buyer's own browser on their own order,
      // and refusing it would leave them staring at a page that does nothing.
      if ((await this.sslcommerz.verifySignature(body)) === 'invalid') {
        this.logger.warn(
          `SSLCommerz ${outcome} callback for ${attempt.paymentId} failed its signature check`,
        );
        return {
          redirectUrl: this.resultUrl({ status: 'pending', ...context }),
        };
      }
      const status = outcome === 'cancel' ? 'cancelled' : 'failed';
      await this.failAttempt(attempt.id, attempt.orderId, status);
      return { redirectUrl: this.resultUrl({ status, ...context }) };
    }

    const settled = await this.settleSslcommerz(attempt, body.val_id ?? '');
    return {
      redirectUrl: this.resultUrl({
        status: settled.status,
        ...context,
        trx: settled.trxId ?? '',
      }),
    };
  }

  /**
   * Server-to-server notification. Carries the same news as the redirect and
   * exists for the buyer who closed the tab on the gateway's page: their
   * money moved, so their order has to land whether or not they came back.
   * Always answered 200 - SSLCommerz retries anything else, and a replay of
   * a decided attempt is a no-op here anyway.
   */
  async handleSslcommerzIpn(body: SslcommerzCallbackBody): Promise<void> {
    const attempt = await this.attempt(body.tran_id ?? '', 'sslcommerz');
    if (!attempt || attempt.status !== 'created') return;

    // Unlike the redirect, an IPN is not a buyer standing in front of us -
    // it is an anonymous POST, and it always carries a signature. No
    // signature, or a wrong one, and it is not SSLCommerz talking.
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
    if (status === 'FAILED') {
      await this.failAttempt(attempt.id, attempt.orderId, 'failed');
    } else if (status === 'CANCELLED' || status === 'EXPIRED') {
      await this.failAttempt(attempt.id, attempt.orderId, 'cancelled');
    }
    // Anything else ('UNATTEMPTED', a status we don't know) is not an
    // outcome - leave the attempt open for the sweep.
  }

  /**
   * Ask SSLCommerz what really happened and act on the answer. The validator
   * is the only statement about the money this trusts, and the amount and
   * transaction id it reports have to be the ones this attempt asked for.
   *
   * An unreachable gateway leaves the attempt 'created' on purpose: the IPN
   * or the sweep will settle it, and voiding a possibly-paid order is the one
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
      await this.failAttempt(attempt.id, attempt.orderId, 'failed');
      return { status: 'failed' };
    }

    await this.claimSuccess(attempt, validation.bankTranId ?? null);
    return { status: 'success', trxId: validation.bankTranId };
  }

  /* ── Shared ────────────────────────────────────────────────────── */

  /** The attempt this callback is about, if the gateway named a real one. */
  private async attempt(
    paymentId: string,
    provider?: string,
  ): Promise<GatewayPaymentRow | undefined> {
    if (!paymentId) return undefined;
    const row = await this.db.query.gatewayPayments.findFirst({
      where: eq(gatewayPayments.paymentId, paymentId),
    });
    // An id is only ever minted by one gateway, so a provider mismatch means
    // the callback is not describing the attempt it named.
    if (provider && row && row.provider !== provider) return undefined;
    return row;
  }

  /**
   * Re-show the result page for an attempt that was already decided, so a
   * back button or a duplicate callback cannot re-run any of it.
   */
  private replay(
    attempt: GatewayPaymentRow,
    context: Record<string, string>,
  ): CallbackOutcome | null {
    if (attempt.status === 'success') {
      return {
        redirectUrl: this.resultUrl({
          status: 'success',
          ...context,
          trx: attempt.trxId ?? '',
        }),
      };
    }
    if (attempt.status !== 'created') {
      return {
        redirectUrl: this.resultUrl({ status: 'cancelled', ...context }),
      };
    }
    return null;
  }

  /**
   * Mark the attempt paid and hand the order on. Guarded on the attempt still
   * being 'created' so the redirect and the IPN racing each other can only
   * confirm the order once.
   */
  private async claimSuccess(
    attempt: GatewayPaymentRow,
    trxId: string | null,
  ): Promise<void> {
    const [claimed] = await this.db
      .update(gatewayPayments)
      .set({ status: 'success', trxId })
      .where(
        and(
          eq(gatewayPayments.id, attempt.id),
          eq(gatewayPayments.status, 'created'),
        ),
      )
      .returning({ id: gatewayPayments.id });
    if (claimed) {
      await this.ordersService.confirmGatewayPayment(attempt.orderId);
    }
  }

  private async failAttempt(
    attemptId: string,
    orderId: string,
    status: 'failed' | 'cancelled' | 'expired',
  ): Promise<void> {
    const [claimed] = await this.db
      .update(gatewayPayments)
      .set({ status })
      .where(
        and(
          eq(gatewayPayments.id, attemptId),
          eq(gatewayPayments.status, 'created'),
        ),
      )
      .returning({ id: gatewayPayments.id });
    if (claimed) await this.ordersService.voidPendingOrder(orderId);
  }

  /** Void attempts (and their orders) the buyer abandoned on the gateway. */
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
        await this.failAttempt(attempt.id, attempt.orderId, 'expired');
      }
      if (stale.length) {
        this.logger.log(`Expired ${stale.length} stale gateway payment(s)`);
      }
    } catch (err) {
      this.logger.error('Pending-payment sweep failed', err as Error);
    }
  }

  /** What the result page needs to describe the order it is reporting on. */
  private async orderContext(
    attempt: GatewayPaymentRow,
  ): Promise<Record<string, string>> {
    const order = await this.db.query.orders.findFirst({
      where: eq(orders.id, attempt.orderId),
      with: { shop: { columns: { handle: true } } },
    });
    // The balance still owed at the door - set only on a 15% advance order,
    // where the gateway collected a part of the total rather than all of it.
    const dueCents =
      order && order.advanceCents > 0
        ? order.totalCents - order.advanceCents
        : 0;
    return {
      ref: order?.reference ?? '',
      shop:
        (order as { shop?: { handle: string } } | undefined)?.shop?.handle ??
        '',
      total: order ? String(attempt.amountCents / 100) : '',
      due: dueCents > 0 ? String(dueCents / 100) : '',
      partial: dueCents > 0 ? '1' : '',
      // Which gateway to name on the receipt line.
      via: attempt.provider,
    };
  }

  private resultUrl(params: Record<string, string>): string {
    const webUrl = (
      this.config.get<string>('app.webUrl') ?? 'http://localhost:5173'
    ).replace(/\/$/, '');
    const query = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== ''),
    );
    return `${webUrl}/pay/result?${query.toString()}`;
  }
}
