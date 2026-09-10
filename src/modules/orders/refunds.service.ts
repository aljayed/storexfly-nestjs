import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import {
  orders,
  paymentRefunds,
  paymentTransactions,
  type PaymentRefundRow,
} from '../../database/schema';
import { SslcommerzService } from '../gateways/sslcommerz.service';

/**
 * How often filed refunds are chased to a conclusion, and how long a refund
 * may sit unresolved before it is called out for a human.
 *
 * Card refunds clear in days, not minutes, so this is a slow poll - it exists
 * so the record ends up truthful, not so anybody watches it happen.
 */
const REFUND_POLL_INTERVAL_MS = 30 * 60 * 1000;
const REFUND_POLL_BATCH = 100;
const REFUND_STALE_DAYS = 14;

/** What a caller learns about a refund it asked for. */
export interface RefundOutcome {
  /** Whether the money is on its way back through the gateway. */
  filed: boolean;
  /**
   * True when there was no gateway charge to reverse - cash on delivery, or a
   * wallet transfer the platform never held. The refund is recorded as
   * 'manual' so somebody pays it back by hand; it is not a failure.
   */
  manual: boolean;
  status: string;
  reason?: string;
}

/**
 * Sending buyers' money back.
 *
 * The order's `pay` column says whether the *shop* still owns the money - it
 * flips to 'Refunded' the moment a refund is accepted, which is what takes the
 * order out of settlement. This service owns the other half of the question:
 * where the money physically is, which for a card is days behind the decision.
 *
 * Deliberately not called from inside a database transaction. Filing a refund
 * is a network round trip to another company, and holding a row lock across
 * one is how a slow gateway turns into a stuck checkout.
 */
@Injectable()
export class RefundsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RefundsService.name);
  private pollTimer?: NodeJS.Timeout;

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly sslcommerz: SslcommerzService,
  ) {}

  onModuleInit(): void {
    this.pollTimer = setInterval(() => {
      void this.sweepPendingRefunds();
    }, REFUND_POLL_INTERVAL_MS);
    this.pollTimer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.pollTimer);
  }

  /**
   * Send an order's money back through whatever took it.
   *
   * Idempotent per order: a refund already filed is reported rather than
   * filed again, so the deadline sweep retrying a cancellation cannot pay a
   * buyer twice.
   */
  async refundOrder(
    orderId: string,
    opts: { reason: string; initiatedBy?: 'seller' | 'auto' } = {
      reason: 'Order refund',
    },
  ): Promise<RefundOutcome> {
    const existing = await this.db.query.paymentRefunds.findFirst({
      where: and(
        eq(paymentRefunds.orderId, orderId),
        inArray(paymentRefunds.status, [
          'requested',
          'processing',
          'refunded',
          'manual',
        ]),
      ),
    });
    if (existing) {
      return {
        filed: existing.status !== 'manual',
        manual: existing.status === 'manual',
        status: existing.status,
      };
    }

    const order = await this.db.query.orders.findFirst({
      where: eq(orders.id, orderId),
    });
    if (!order) {
      return { filed: false, manual: false, status: 'failed', reason: 'Order not found' };
    }

    // The charge to reverse: the most recent settled transaction for this
    // order. Orders paid in cash or by direct wallet transfer have none.
    const charge = await this.db.query.paymentTransactions.findFirst({
      where: eq(paymentTransactions.orderId, orderId),
      orderBy: [desc(paymentTransactions.capturedAt)],
    });

    const [row] = await this.db
      .insert(paymentRefunds)
      .values({
        orderId,
        transactionId: charge?.id,
        provider: charge?.provider ?? 'none',
        refundTransId: RefundsService.mintRefundId(),
        bankTranId: charge?.gatewayTxnId,
        amountCents: charge?.amountCents ?? order.totalCents,
        reason: opts.reason.slice(0, 255),
        initiatedBy: opts.initiatedBy ?? 'seller',
        // No charge to reverse, or one taken by a provider with no refund
        // API wired up - either way a person has to move the money.
        status:
          charge && charge.provider === 'sslcommerz' ? 'requested' : 'manual',
      })
      .returning();

    if (row.status === 'manual') {
      this.logger.warn(
        `Order ${order.reference}: ${formatReason(charge?.provider)} - refund of ${row.amountCents} recorded for manual payout`,
      );
      return { filed: false, manual: true, status: 'manual' };
    }

    return this.fileWithGateway(row, order.reference);
  }

  /** Hand one 'requested' refund to SSLCommerz and record what it said. */
  private async fileWithGateway(
    row: PaymentRefundRow,
    reference: string,
  ): Promise<RefundOutcome> {
    const result = await this.sslcommerz.refund({
      bankTranId: row.bankTranId!,
      refundTransId: row.refundTransId,
      amountCents: row.amountCents,
      remarks: row.reason ?? `Refund for ${reference}`,
    });

    if (result.status === 'unreachable') {
      // The row stays 'requested'; the sweep retries it. Filing the same
      // `refund_trans_id` again is safe - the gateway answers 'processing'
      // for the existing refund rather than opening a second one.
      this.logger.warn(
        `Order ${reference}: refund could not be filed yet (${result.reason ?? 'unreachable'}) - will retry`,
      );
      return { filed: false, manual: false, status: 'requested', reason: result.reason };
    }

    const status = result.status === 'failed' ? 'failed' : 'processing';
    await this.db
      .update(paymentRefunds)
      .set({
        status,
        refundRefId: result.refundRefId,
        errorReason: result.reason?.slice(0, 500),
      })
      .where(eq(paymentRefunds.id, row.id));

    if (status === 'failed') {
      this.logger.error(
        `Order ${reference}: gateway refused the refund - ${result.reason ?? 'no reason given'}`,
      );
      return { filed: false, manual: false, status, reason: result.reason };
    }
    this.logger.log(
      `Order ${reference}: refund filed (${result.refundRefId ?? 'no ref'})`,
    );
    return { filed: true, manual: false, status };
  }

  /**
   * Chase filed refunds to a conclusion: retry the ones that never reached the
   * gateway, and ask after the ones that did.
   */
  async sweepPendingRefunds(): Promise<void> {
    const pending = await this.db.query.paymentRefunds.findMany({
      where: inArray(paymentRefunds.status, ['requested', 'processing']),
      limit: REFUND_POLL_BATCH,
    });

    for (const row of pending) {
      try {
        if (row.status === 'requested') {
          // Never made it out. Only SSLCommerz rows get here - a 'manual' one
          // is not 'requested'.
          const order = row.orderId
            ? await this.db.query.orders.findFirst({
                where: eq(orders.id, row.orderId),
              })
            : null;
          await this.fileWithGateway(row, order?.reference ?? row.refundTransId);
          continue;
        }
        if (!row.refundRefId) continue;
        const state = await this.sslcommerz.refundStatus(row.refundRefId);
        if (state.status === 'refunded') {
          await this.db
            .update(paymentRefunds)
            .set({ status: 'refunded', settledAt: new Date() })
            .where(eq(paymentRefunds.id, row.id));
        } else if (state.status === 'cancelled') {
          await this.db
            .update(paymentRefunds)
            .set({
              status: 'failed',
              errorReason: (state.reason ?? 'Cancelled at the gateway').slice(0, 500),
            })
            .where(eq(paymentRefunds.id, row.id));
          this.logger.error(
            `Refund ${row.refundRefId} was cancelled at the gateway - the buyer has not been paid`,
          );
        }
      } catch (err) {
        this.logger.error(
          `Refund poll failed for ${row.id}: ${(err as Error).message}`,
        );
      }
    }

    // Anything still moving after a fortnight is not moving. Say so loudly:
    // a refund nobody notices is a buyer who was never paid back.
    const staleBefore = new Date(
      Date.now() - REFUND_STALE_DAYS * 24 * 3600_000,
    );
    const stale = await this.db
      .select({ id: paymentRefunds.id, ref: paymentRefunds.refundTransId })
      .from(paymentRefunds)
      .where(
        and(
          inArray(paymentRefunds.status, ['requested', 'processing']),
          lt(paymentRefunds.requestedAt, staleBefore),
        ),
      );
    if (stale.length) {
      this.logger.error(
        `${stale.length} refund(s) still unresolved after ${REFUND_STALE_DAYS} days: ${stale
          .map((s) => s.ref)
          .join(', ')}`,
      );
    }
  }

  /** Refunds against an order, newest first - for the console and support. */
  async forOrder(orderId: string): Promise<PaymentRefundRow[]> {
    return this.db.query.paymentRefunds.findMany({
      where: eq(paymentRefunds.orderId, orderId),
      orderBy: [desc(paymentRefunds.requestedAt)],
    });
  }

  /**
   * The gateway caps `refund_trans_id` at 30 characters and wants it unique
   * forever, so this is time-ordered (which keeps them sortable and readable
   * in their portal) with random bytes on the end.
   */
  private static mintRefundId(): string {
    return `rf${Date.now().toString(36)}${randomBytes(5).toString('hex')}`;
  }
}

function formatReason(provider?: string): string {
  if (!provider) return 'no gateway charge to reverse';
  return `payments through ${provider} cannot be refunded automatically`;
}
