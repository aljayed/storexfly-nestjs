import {
  BadRequestException,
  ConflictException,
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
import { and, asc, count, desc, eq, isNull, lte, sql } from 'drizzle-orm';
import {
  FREE_MAX_PRODUCTS,
  FREE_SALES_CAP_CENTS,
  FREE_TIER_LIMIT_MESSAGE,
  PLATFORM_CURRENCY,
} from '../../common/constants/billing';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import {
  orders,
  products,
  shops,
  subscriptionPayments,
  subscriptions,
  type ShopRow,
  type SubscriptionPaymentRow,
  type SubscriptionRow,
} from '../../database/schema';
import { BillingSettingsService } from '../billing/billing-settings.service';
import { CouponsService } from '../coupons/coupons.service';
import { ReferralsService } from '../referrals/referrals.service';
import {
  ShopCreditResponse,
  SubscriptionResponse,
} from './dto/subscription.response';

export { PLATFORM_CURRENCY };

/** How often the background billing sweep looks for due subscriptions. */
const BILLING_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * How long a past_due subscription keeps its storefront live. After the
 * grace period the shop is forced offline until the seller pays.
 */
const PAST_DUE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

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
    private readonly billing: BillingSettingsService,
    private readonly referrals: ReferralsService,
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
    refSlug?: string,
  ): Promise<ShopCreditResponse> {
    const existing = await this.findUnconsumedCredit(userId);
    if (existing) {
      return ShopCreditResponse.fromRow(existing);
    }

    // Read the fee once so the coupon check and the charge can never see two
    // different prices, even if the operator changes it mid-request.
    const feeCents = await this.billing.monthlyFeeCents();
    let coupon: { id: string; code: string } | undefined;
    let discountCents = 0;
    if (couponCode?.trim()) {
      const check = await this.coupons.check(couponCode, userId, feeCents);
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
        amountCents: feeCents - discountCents,
        currency: PLATFORM_CURRENCY,
        couponId: coupon?.id,
        couponCode: coupon?.code,
        discountCents,
      })
      .returning();
    if (coupon) {
      await this.coupons.markRedeemed(coupon.id);
      // Attribution only — recordSignup never throws and only counts when
      // the slug still maps to the coupon that was actually redeemed.
      if (refSlug?.trim()) {
        await this.referrals.recordSignup(refSlug, coupon.id);
      }
    }
    return ShopCreditResponse.fromRow(row);
  }

  /** Whether the seller holds a paid, not-yet-used shop-creation credit. */
  async getShopCreationCredit(userId: string): Promise<ShopCreditResponse> {
    const existing = await this.findUnconsumedCredit(userId);
    return existing
      ? ShopCreditResponse.fromRow(existing)
      : {
          paid: false,
          amount: (await this.billing.monthlyFeeCents()) / 100,
          currency: PLATFORM_CURRENCY,
        };
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
          message: 'Pay the shop subscription fee before creating a shop.',
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
        amountCents: await this.billing.monthlyFeeCents(),
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

  /**
   * Console view. A paid shop settles + returns its subscription; a free
   * shop has none — it returns the free-tier card (limits + usage) instead.
   */
  async getForShop(shopId: string): Promise<SubscriptionResponse> {
    const shop = await this.requireShop(shopId);
    if (shop.plan === 'free') {
      return this.freeTierResponse(shop);
    }
    const sub = await this.settle(await this.requireByShop(shopId));
    return this.toResponse(sub);
  }

  /**
   * Upgrade a free shop: consumes the seller's paid shop credit (the same
   * first payment used at shop creation) and opens the monthly
   * subscription. Also lifts a free-tier deactivation so the seller can go
   * live again immediately.
   */
  async activateForExistingShop(shopId: string): Promise<SubscriptionResponse> {
    const shop = await this.requireShop(shopId);
    if (shop.plan !== 'free') {
      return this.getForShop(shopId);
    }
    const sub = await this.activateForNewShop(shop.ownerId, shopId);
    await this.db
      .update(shops)
      .set({ plan: 'paid', live: true })
      .where(eq(shops.id, shopId));
    return this.toResponse(sub);
  }

  /** Free-tier usage numbers for one shop (products used, sales vs cap). */
  private async freeTierUsage(shopId: string): Promise<{
    salesCents: number;
    productsCount: number;
  }> {
    const [[{ cents }], [{ n }]] = await Promise.all([
      this.db
        .select({
          cents: sql<string>`coalesce(sum(${orders.totalCents}) filter (where ${orders.status} <> 'Cancelled'), 0)`,
        })
        .from(orders)
        .where(eq(orders.shopId, shopId)),
      this.db
        .select({ n: count() })
        .from(products)
        .where(eq(products.shopId, shopId)),
    ]);
    return { salesCents: Number(cents), productsCount: Number(n) };
  }

  private async freeTierResponse(shop: ShopRow): Promise<SubscriptionResponse> {
    const usage = await this.freeTierUsage(shop.id);
    return SubscriptionResponse.freeTier(shop, {
      salesCents: usage.salesCents,
      salesCapCents: FREE_SALES_CAP_CENTS,
      productsCount: usage.productsCount,
      maxProducts: FREE_MAX_PRODUCTS,
      monthlyFeeCents: await this.billing.monthlyFeeCents(),
    });
  }

  private async requireShop(shopId: string): Promise<ShopRow> {
    const shop = await this.db.query.shops.findFirst({
      where: eq(shops.id, shopId),
    });
    if (!shop) {
      throw new NotFoundException('Shop not found');
    }
    return shop;
  }

  /**
   * Manual "Pay now" for an overdue renewal. Covers exactly one billing
   * period starting at the *scheduled* due date, so the next payment date
   * keeps its original anchor no matter how late the payment is made.
   */
  async payNow(shopId: string): Promise<SubscriptionResponse> {
    const sub = await this.settle(await this.requireByShop(shopId));
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
    // Guarded like `settle`: a double-submitted "Pay now" charges once.
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
      .where(
        and(
          eq(subscriptions.id, sub.id),
          eq(subscriptions.nextBillingAt, sub.nextBillingAt),
        ),
      )
      .returning();
    if (!updated) {
      throw new ConflictException(
        'This renewal was just paid — refresh to see the latest state.',
      );
    }
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
    return this.toResponse(updated);
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
   * Resume a cancelled subscription. The months spent cancelled are never
   * billed: if the paid-up period already lapsed, billing re-anchors to
   * today and exactly one month is charged now; if the seller resumes
   * inside a period they already paid for, nothing is charged and the
   * original anchor is kept. Either way the shop goes back live.
   */
  async resume(shopId: string): Promise<SubscriptionResponse> {
    const sub = await this.requireByShop(shopId);
    if (sub.status !== 'cancelled') {
      return this.toResponse(await this.settle(sub));
    }
    const now = new Date();
    const lapsed = sub.nextBillingAt <= now;
    // Guarded on status so a double-submitted resume charges once — the
    // loser matches zero rows and just reloads the fresh state.
    const [reactivated] = await this.db
      .update(subscriptions)
      .set(
        lapsed
          ? {
              status: 'active',
              cancelledAt: null,
              startedAt: now,
              nextBillingAt: addOneMonth(now, now.getDate()),
              pendingCouponId: null,
              pendingCouponCode: null,
              pendingDiscountCents: 0,
            }
          : { status: 'active', cancelledAt: null },
      )
      .where(
        and(
          eq(subscriptions.id, sub.id),
          eq(subscriptions.status, 'cancelled'),
        ),
      )
      .returning();
    if (!reactivated) {
      const fresh = await this.db.query.subscriptions.findFirst({
        where: eq(subscriptions.id, sub.id),
      });
      return this.toResponse(fresh ?? sub);
    }
    if (lapsed) {
      // The single month bought by resuming. A coupon that was pending when
      // the subscription got cancelled discounts it.
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
        periodStart: now,
        periodEnd: reactivated.nextBillingAt,
        paidAt: now,
      });
    }
    // Cancelling forced the storefront off; resuming brings it back.
    await this.db.update(shops).set({ live: true }).where(eq(shops.id, shopId));
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
      throw new BadRequestException(
        this.coupons.rejectionMessage(check.reason),
      );
    }
    // One transaction: attach the new coupon, take its redemption, release
    // the replaced one — a failure part-way leaks nothing.
    const updated = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(subscriptions)
        .set({
          pendingCouponId: check.coupon.id,
          pendingCouponCode: check.coupon.code,
          pendingDiscountCents: check.discountCents,
        })
        .where(eq(subscriptions.id, sub.id))
        .returning();
      await this.coupons.markRedeemed(check.coupon.id, tx);
      if (sub.pendingCouponId) {
        await this.coupons.release(sub.pendingCouponId, tx);
      }
      return row;
    });
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

  /**
   * Turn the storefront on/off. Going live requires a non-cancelled sub
   * (paid plan) or headroom under the sales cap (free plan).
   */
  async setShopLive(shopId: string, live: boolean): Promise<{ live: boolean }> {
    if (live) {
      const shop = await this.requireShop(shopId);
      if (shop.plan === 'free') {
        const usage = await this.freeTierUsage(shopId);
        if (usage.salesCents >= FREE_SALES_CAP_CENTS) {
          throw new ForbiddenException(FREE_TIER_LIMIT_MESSAGE);
        }
      } else {
        const sub = await this.requireByShop(shopId);
        if (sub.status === 'cancelled') {
          throw new ForbiddenException(
            'Your subscription is cancelled — resume it to make the shop live.',
          );
        }
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

    // A shop unpaid beyond the grace period goes offline until the dues clear.
    if (
      status === 'past_due' &&
      now.getTime() - sub.nextBillingAt.getTime() > PAST_DUE_GRACE_MS
    ) {
      await this.db
        .update(shops)
        .set({ live: false })
        .where(and(eq(shops.id, sub.shopId), eq(shops.live, true)));
    }

    if (status === sub.status && collected.length === 0) {
      return sub;
    }

    // Optimistic guard: the update only wins while `nextBillingAt` is still
    // what we based the charges on. If the hourly sweep and a console read
    // settle concurrently, exactly one records the renewals — the loser
    // simply reloads, instead of double-charging the seller.
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
      .where(
        and(
          eq(subscriptions.id, sub.id),
          eq(subscriptions.nextBillingAt, sub.nextBillingAt),
          eq(subscriptions.status, sub.status),
        ),
      )
      .returning();
    if (!updated) {
      const fresh = await this.db.query.subscriptions.findFirst({
        where: eq(subscriptions.id, sub.id),
      });
      return fresh ?? sub;
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
    // Free shops have no subscription to act on — they upgrade first.
    if (shop.plan === 'free') {
      throw new ForbiddenException(
        'This shop is on the free plan — subscribe to use billing features.',
      );
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
        amountCents: await this.billing.monthlyFeeCents(),
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
