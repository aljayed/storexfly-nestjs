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
import { BkashService } from '../gateways/bkash.service';
import { OrdersService } from './orders.service';

/** How long a buyer gets to finish paying on bKash before the order voids. */
const PENDING_TTL_MS = 45 * 60 * 1000;
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

export interface CallbackOutcome {
  /** Where to send the buyer's browser. */
  redirectUrl: string;
}

/**
 * The return leg of bKash hosted checkout. bKash redirects the buyer to
 * /payments/bkash/callback with `paymentID` + `status`; a success executes
 * (captures) the payment, verifies the amount and marks the order paid.
 * Anything else voids the pending order so its stock frees up immediately.
 * A background sweep does the same for buyers who never came back.
 */
@Injectable()
export class PaymentsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PaymentsService.name);
  private sweepTimer?: NodeJS.Timeout;

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly ordersService: OrdersService,
    private readonly bkash: BkashService,
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

  async handleBkashCallback(
    paymentId: string,
    status: string,
  ): Promise<CallbackOutcome> {
    const attempt = await this.db.query.gatewayPayments.findFirst({
      where: eq(gatewayPayments.paymentId, paymentId),
    });
    if (!attempt) {
      return { redirectUrl: this.resultUrl({ status: 'failed' }) };
    }
    const order = await this.db.query.orders.findFirst({
      where: eq(orders.id, attempt.orderId),
      with: { shop: { columns: { handle: true } } },
    });
    const context = {
      ref: order?.reference ?? '',
      shop:
        (order as { shop?: { handle: string } } | undefined)?.shop?.handle ??
        '',
      total: order ? String(order.totalCents / 100) : '',
    };

    // Replays of an already-decided attempt just re-show the result page.
    if (attempt.status === 'success') {
      return { redirectUrl: this.resultUrl({ status: 'success', ...context }) };
    }
    if (attempt.status !== 'created') {
      return {
        redirectUrl: this.resultUrl({ status: 'cancelled', ...context }),
      };
    }

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

    await this.db
      .update(gatewayPayments)
      .set({ status: 'success', trxId: executed.trxId })
      .where(eq(gatewayPayments.id, attempt.id));
    await this.ordersService.confirmGatewayPayment(attempt.orderId);
    return {
      redirectUrl: this.resultUrl({
        status: 'success',
        ...context,
        trx: executed.trxId ?? '',
      }),
    };
  }

  private async failAttempt(
    attemptId: string,
    orderId: string,
    status: 'failed' | 'cancelled' | 'expired',
  ): Promise<void> {
    await this.db
      .update(gatewayPayments)
      .set({ status })
      .where(eq(gatewayPayments.id, attemptId));
    await this.ordersService.voidPendingOrder(orderId);
  }

  /** Void attempts (and their orders) the buyer abandoned on bKash. */
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
        this.logger.log(`Expired ${stale.length} stale bKash payment(s)`);
      }
    } catch (err) {
      this.logger.error('Pending-payment sweep failed', err as Error);
    }
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
