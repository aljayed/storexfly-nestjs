import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { and, asc, desc, eq, isNull, lte } from 'drizzle-orm';
import {
  MONTHLY_FEE_CENTS,
  PLATFORM_CURRENCY,
} from '../../common/constants/billing';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import {
  shops,
  subscriptionPayments,
  subscriptions,
  type SubscriptionPaymentRow,
  type SubscriptionRow,
} from '../../database/schema';
import { CouponsService } from '../coupons/coupons.service';
import {
  ShopCreditResponse,
  SubscriptionResponse,
} from './dto/subscription.response';

export { MONTHLY_FEE_CENTS, PLATFORM_CURRENCY };

/** How often the background billing sweep looks for due subscriptions. */
const BILLING_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * One calendar month after `from`, keeping the subscription's anchor
 * day-of-month (clamped to the target month's last day, e.g. 31st → Feb 28).
 */
function addOneMonth(from: Date, anchorDay: number): Date {
  const next = new Date(from);
  const year = next.getFullYear();
  const month = next.getMonth() + 1;
  const lastDay = new Date(year, month + 1, 0).getDate();
  next.setFullYear(year, month, Math.min(anchorDay, lastDay));
  return next;
}

@Injectable()
export class SubscriptionsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SubscriptionsService.name);
  private sweepTimer?: NodeJS.Timeout;

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly coupons: CouponsService,
  ) {}

  onModuleInit(): void {
    // Hourly auto-debit sweep. Reads also settle lazily, so this only exists
    // to keep billing moving while nobody is looking at the console.
    this.sweepTimer = setInterval(() => {
      void this.sweepDueSubscriptions();
    }, BILLING_SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
    void this.sweepDueSubscriptions();
  }

  onModuleDestroy(): void {
    clearInterval(this.sweepTimer);
  }

  // ── Shop-creation fee (paid before the shop exists) ───────────

  /**
   * Dummy payment gateway for the one-off shop-creation fee. Idempotent: if
   * the seller already holds an unconsumed credit it is returned as-is
   * instead of charging twice. An optional coupon code discounts this first
   * payment; an invalid code fails the whole payment with a 400 rather than
   * silently charging full price.
   */
  async payShopCreationFee(
    userId: string,
    couponCode?: string,
  ): Promise<ShopCreditResponse> {
    const existing = await this.findUnconsumedCredit(userId);
    if (existing) {
      return ShopCreditResponse.fromRow(existing);
    }

    let coupon: { id: string; code: string } | undefined;
    let discountCents = 0;
    if (couponCode?.trim()) {
      const check = await this.coupons.checkForShopCreation(
        couponCode,
        userId,
      );
      if (!check.ok) {
        throw new BadRequestException(
          this.coupons.rejectionMessage(check.reason),
        );
      }
      coupon = check.coupon;
      discountCents = check.discountCents;
    }

    const [row] = await this.db
      .insert(subscriptionPayments)
      .values({
        userId,
        type: 'shop_creation',
        method: 'manual',
        amountCents: MONTHLY_FEE_CENTS - discountCents,
        currency: PLATFORM_CURRENCY,
        couponId: coupon?.id,
        couponCode: coupon?.code,
        discountCents,
      })
      .returning();
    if (coupon) {
      await this.coupons.markRedeemed(coupon.id);
    }
    return ShopCreditResponse.fromRow(row);
  }

  /** Whether the seller holds a paid, not-yet-used shop-creation credit. */
  async getShopCreationCredit(userId: string): Promise<ShopCreditResponse> {
    const existing = await this.findUnconsumedCredit(userId);
    return existing
      ? ShopCreditResponse.fromRow(existing)
      : { paid: false, amount: MONTHLY_FEE_CENTS / 100, currency: PLATFORM_CURRENCY };
  }

  /**
   * Called by the create-shop flow: consumes the seller's credit and opens
   * the shop's subscription (first renewal due one month from now). Throws
   * 402 when no payment has been made.
   */
  async activateForNewShop(
    userId: string,
    shopId: string,
  ): Promise<SubscriptionRow> {
    const credit = await this.findUnconsumedCredit(userId);
    if (!credit) {
      throw new HttpException(
        {
          statusCode: HttpStatus.PAYMENT_REQUIRED,
          error: 'PaymentRequired',
          message: 'Pay the ৳1,199 shop fee before creating a shop.',
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
    const startedAt = new Date();
    const [sub] = await this.db
      .insert(subscriptions)
      .values({
        shopId,
        ownerId: userId,
        status: 'active',
        amountCents: MONTHLY_FEE_CENTS,
        currency: PLATFORM_CURRENCY,
        startedAt,
        nextBillingAt: addOneMonth(startedAt, startedAt.getDate()),
      })
      .returning();
    await this.db
      .update(subscriptionPayments)
      .set({ consumedAt: new Date(), shopId, subscriptionId: sub.id })
      .where(eq(subscriptionPayments.id, credit.id));
    return sub;
  }

  /** True when the seller can submit the create-shop wizard. */
  async hasUnconsumedCredit(userId: string): Promise<boolean> {
    return !!(await this.findUnconsumedCredit(userId));
  }

  private async findUnconsumedCredit(
    userId: string,
  ): Promise<SubscriptionPaymentRow | undefined> {
    return this.db.query.subscriptionPayments.findFirst({
      where: and(
        eq(subscriptionPayments.userId, userId),
        eq(subscriptionPayments.type, 'shop_creation'),
        isNull(subscriptionPayments.consumedAt),
      ),
      orderBy: [asc(subscriptionPayments.paidAt)],
    });
  }

  // ── Subscription lifecycle ─────────────────────────────────────

  /** Console view: subscription + payment history, settled up to now. */
  async getForShop(shopId: string): Promise<SubscriptionResponse> {
    const sub = await this.settle(await this.requireByShop(shopId));
    return this.toResponse(sub);
  }

  /**
   * Manual "Pay now" for an overdue renewal. Covers exactly one billing
   * period starting at the *scheduled* due date, so the next payment date
   * keeps its original anchor no matter how late the payment is made.
   */
  async payNow(shopId: string): Promise<SubscriptionResponse> {
    let sub = await this.settle(await this.requireByShop(shopId));
    if (sub.status === 'cancelled') {
      throw new ForbiddenException(
        'This subscription is cancelled. Resume it before paying.',
      );
    }
    const now = new Date();
    if (sub.nextBillingAt > now) {
      throw new BadRequestException('No payment is due yet.');
    }
    const anchorDay = sub.startedAt.getDate();
    const periodStart = sub.nextBillingAt;
    const periodEnd = addOneMonth(periodStart, anchorDay);
    await this.db.insert(subscriptionPayments).values({
      userId: sub.ownerId,
      subscriptionId: sub.id,
      shopId: sub.shopId,
      type: 'renewal',
      method: 'manual',
      amountCents: sub.amountCents - sub.pendingDiscountCents,
      currency: sub.currency,
      couponId: sub.pendingCouponId ?? undefined,
      couponCode: sub.pendingCouponCode ?? undefined,
      discountCents: sub.pendingDiscountCents,
      periodStart,
      periodEnd,
      paidAt: now,
    });
    const [updated] = await this.db
      .update(subscriptions)
      .set({
        nextBillingAt: periodEnd,
        // Still behind by more than a full period? Stay past_due.
        status: periodEnd > now ? 'active' : 'past_due',
        // The pending coupon covered this payment.
        pendingCouponId: null,
        pendingCouponCode: null,
        pendingDiscountCents: 0,
      })
      .where(eq(subscriptions.id, sub.id))
      .returning();
    sub = updated;
    return this.toResponse(sub);
  }

  /** Cancel: stops billing and forces the shop offline immediately. */
  async cancel(shopId: string): Promise<SubscriptionResponse> {
    const sub = await this.requireByShop(shopId);
    if (sub.status === 'cancelled') {
      return this.toResponse(sub);
    }
    const [updated] = await this.db
      .update(subscriptions)
      .set({ status: 'cancelled', cancelledAt: new Date() })
      .where(eq(subscriptions.id, sub.id))
      .returning();
    await this.db
      .update(shops)
      .set({ live: false })
      .where(eq(shops.id, shopId));
    return this.toResponse(updated);
  }

  /**
   * Resume a cancelled subscription. Billing restarts from the original
   * anchor; if the due date passed while cancelled it settles immediately
   * (auto-debit) or lands in past_due awaiting a manual payment.
   */
  async resume(shopId: string): Promise<SubscriptionResponse> {
    const sub = await this.requireByShop(shopId);
    if (sub.status !== 'cancelled') {
      return this.toResponse(await this.settle(sub));
    }
    const [reactivated] = await this.db
      .update(subscriptions)
      .set({ status: 'active', cancelledAt: null })
      .where(eq(subscriptions.id, sub.id))
      .returning();
    return this.toResponse(await this.settle(reactivated));
  }

  async setAutoDebit(
    shopId: string,
    enabled: boolean,
  ): Promise<SubscriptionResponse> {
    const sub = await this.requireByShop(shopId);
    const [updated] = await this.db
      .update(subscriptions)
      .set({ autoDebit: enabled })
      .where(eq(subscriptions.id, sub.id))
      .returning();
    return this.toResponse(await this.settle(updated));
  }

  // ── Renewal coupon ─────────────────────────────────────────────

  /**
   * Apply a coupon to the shop's next renewal payment. The discount sits on
   * the subscription until that renewal is collected (auto-debit or manual
   * "Pay now"), which consumes it. Re-applying replaces any pending coupon,
   * releasing the old one's redemption.
   */
  async applyCoupon(
    shopId: string,
    code: string,
  ): Promise<SubscriptionResponse> {
    const sub = await this.settle(await this.requireByShop(shopId));
    if (sub.status === 'cancelled') {
      throw new ForbiddenException(
        'This subscription is cancelled. Resume it before applying a coupon.',
      );
    }
    const check = await this.coupons.check(code, sub.ownerId, sub.amountCents);
    if (!check.ok) {
      throw new BadRequestException(this.coupons.rejectionMessage(check.reason));
    }
    const [updated] = await this.db
      .update(subscriptions)
      .set({
        pendingCouponId: check.coupon.id,
        pendingCouponCode: check.coupon.code,
        pendingDiscountCents: check.discountCents,
      })
      .where(eq(subscriptions.id, sub.id))
      .returning();
    await this.coupons.markRedeemed(check.coupon.id);
    if (sub.pendingCouponId) {
      await this.coupons.release(sub.pendingCouponId);
    }
    return this.toResponse(updated);
  }

  /** Remove a pending (not yet charged) coupon from the next renewal. */
  async removeCoupon(shopId: string): Promise<SubscriptionResponse> {
    const sub = await this.requireByShop(shopId);
    if (!sub.pendingCouponId && !sub.pendingCouponCode) {
      return this.toResponse(await this.settle(sub));
    }
    const [updated] = await this.db
      .update(subscriptions)
      .set({
        pendingCouponId: null,
        pendingCouponCode: null,
        pendingDiscountCents: 0,
      })
      .where(eq(subscriptions.id, sub.id))
      .returning();
    if (sub.pendingCouponId) {
      await this.coupons.release(sub.pendingCouponId);
    }
    return this.toResponse(await this.settle(updated));
  }

  // ── Shop live toggle ───────────────────────────────────────────

  /** Turn the storefront on/off. Going live requires a non-cancelled sub. */
  async setShopLive(
    shopId: string,
    live: boolean,
  ): Promise<{ live: boolean }> {
    if (live) {
      const sub = await this.requireByShop(shopId);
      if (sub.status === 'cancelled') {
        throw new ForbiddenException(
          'Your subscription is cancelled — resume it to make the shop live.',
        );
      }
    }
    const [row] = await this.db
      .update(shops)
      .set({ live })
      .where(eq(shops.id, shopId))
      .returning({ live: shops.live });
    if (!row) {
      throw new NotFoundException('Shop not found');
    }
    return { live: row.live };
  }

  // ── Billing engine ─────────────────────────────────────────────

  /**
   * Bring a subscription up to date. While the due date is in the past:
   * auto-debit collects each elapsed period (dummy gateway — always
   * succeeds) and rolls the anchor forward; without auto-debit the sub is
   * parked in past_due until the seller pays manually.
   */
  private async settle(sub: SubscriptionRow): Promise<SubscriptionRow> {
    if (sub.status === 'cancelled') {
      return sub;
    }
    const now = new Date();
    const anchorDay = sub.startedAt.getDate();
    let next = sub.nextBillingAt;
    let status = sub.status;
    const collected: { periodStart: Date; periodEnd: Date }[] = [];

    while (next <= now) {
      if (!sub.autoDebit) {
        status = 'past_due';
        break;
      }
      const periodEnd = addOneMonth(next, anchorDay);
      collected.push({ periodStart: next, periodEnd });
      next = periodEnd;
      status = 'active';
    }
    if (status === sub.status && collected.length === 0) {
      return sub;
    }

    if (collected.length > 0) {
      // A pending coupon discounts only the first (earliest) renewal charged.
      await this.db.insert(subscriptionPayments).values(
        collected.map((period, i) => ({
          userId: sub.ownerId,
          subscriptionId: sub.id,
          shopId: sub.shopId,
          type: 'renewal' as const,
          method: 'auto' as const,
          amountCents:
            sub.amountCents - (i === 0 ? sub.pendingDiscountCents : 0),
          currency: sub.currency,
          couponId: (i === 0 ? sub.pendingCouponId : null) ?? undefined,
          couponCode: (i === 0 ? sub.pendingCouponCode : null) ?? undefined,
          discountCents: i === 0 ? sub.pendingDiscountCents : 0,
          periodStart: period.periodStart,
          periodEnd: period.periodEnd,
          paidAt: now,
        })),
      );
      this.logger.log(
        `Auto-debited ${collected.length} renewal(s) for subscription ${sub.id}`,
      );
    }
    const [updated] = await this.db
      .update(subscriptions)
      .set({
        nextBillingAt: next,
        status,
        ...(collected.length > 0 && {
          pendingCouponId: null,
          pendingCouponCode: null,
          pendingDiscountCents: 0,
        }),
      })
      .where(eq(subscriptions.id, sub.id))
      .returning();
    return updated;
  }

  /** Background sweep: settle every non-cancelled subscription that is due. */
  private async sweepDueSubscriptions(): Promise<void> {
    try {
      const due = await this.db.query.subscriptions.findMany({
        where: and(
          eq(subscriptions.status, 'active'),
          lte(subscriptions.nextBillingAt, new Date()),
        ),
      });
      for (const sub of due) {
        await this.settle(sub);
      }
    } catch (err) {
      this.logger.error('Billing sweep failed', err as Error);
    }
  }

  // ── Helpers ────────────────────────────────────────────────────

  /**
   * Load (or lazily backfill) the shop's subscription. Shops created before
   * the subscription system get an active sub anchored on their creation
   * day, first renewal at the next future anchor date.
   */
  private async requireByShop(shopId: string): Promise<SubscriptionRow> {
    const existing = await this.db.query.subscriptions.findFirst({
      where: eq(subscriptions.shopId, shopId),
    });
    if (existing) {
      return existing;
    }
    const shop = await this.db.query.shops.findFirst({
      where: eq(shops.id, shopId),
    });
    if (!shop) {
      throw new NotFoundException('Shop not found');
    }
    const startedAt = shop.createdAt;
    const anchorDay = startedAt.getDate();
    const now = new Date();
    let nextBillingAt = addOneMonth(startedAt, anchorDay);
    while (nextBillingAt <= now) {
      nextBillingAt = addOneMonth(nextBillingAt, anchorDay);
    }
    const [created] = await this.db
      .insert(subscriptions)
      .values({
        shopId,
        ownerId: shop.ownerId,
        status: 'active',
        amountCents: MONTHLY_FEE_CENTS,
        currency: PLATFORM_CURRENCY,
        startedAt,
        nextBillingAt,
      })
      .returning();
    return created;
  }

  private async toResponse(
    sub: SubscriptionRow,
  ): Promise<SubscriptionResponse> {
    const [shop, payments] = await Promise.all([
      this.db.query.shops.findFirst({
        where: eq(shops.id, sub.shopId),
        columns: { live: true },
      }),
      this.db.query.subscriptionPayments.findMany({
        where: eq(subscriptionPayments.subscriptionId, sub.id),
        orderBy: [desc(subscriptionPayments.paidAt)],
      }),
    ]);
    return SubscriptionResponse.fromRows(sub, shop?.live ?? false, payments);
  }
}
