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
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  isNull,
  lt,
  ne,
  sql,
} from 'drizzle-orm';
import {
  CAP_GRACE_MS,
  FREE_MAX_PRODUCTS,
  FREE_ORDER_CAP,
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
import {
  BillingSettingsService,
  type PlanView,
} from '../billing/billing-settings.service';
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

/** The mirror of `addOneMonth`: one calendar month before `from`. */
function subOneMonth(from: Date, anchorDay: number): Date {
  const prev = new Date(from);
  const year = prev.getFullYear();
  const month = prev.getMonth() - 1;
  const lastDay = new Date(year, month + 1, 0).getDate();
  prev.setFullYear(year, month, Math.min(anchorDay, lastDay));
  return prev;
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

    // Read the entry plan once so the coupon check and the charge can never
    // see two different prices, even if the operator re-prices mid-request.
    const entry = await this.billing.entryPlan();
    const feeCents = entry.priceCents;
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
        planCode: entry.code,
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
    // A new shop always starts on the entry rung; it climbs from the console
    // (or on its own, once the seller turns auto-scale on).
    const entry = await this.billing.entryPlan();
    const startedAt = new Date();
    const [sub] = await this.db
      .insert(subscriptions)
      .values({
        shopId,
        ownerId: userId,
        status: 'active',
        planCode: entry.code,
        amountCents: entry.priceCents,
        currency: PLATFORM_CURRENCY,
        startedAt,
        nextBillingAt: addOneMonth(startedAt, startedAt.getDate()),
      })
      .returning();
    await this.db
      .update(subscriptionPayments)
      .set({
        consumedAt: new Date(),
        shopId,
        subscriptionId: sub.id,
        planCode: entry.code,
      })
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

  /** Free-tier usage numbers for one shop (products used, orders vs cap). */
  private async freeTierUsage(shopId: string): Promise<{
    ordersCount: number;
    productsCount: number;
  }> {
    const [[{ placed }], [{ n }]] = await Promise.all([
      this.db
        .select({
          placed: sql<string>`count(*) filter (where ${orders.status} <> 'Cancelled')`,
        })
        .from(orders)
        .where(eq(orders.shopId, shopId)),
      this.db
        .select({ n: count() })
        .from(products)
        .where(eq(products.shopId, shopId)),
    ]);
    return { ordersCount: Number(placed), productsCount: Number(n) };
  }

  private async freeTierResponse(shop: ShopRow): Promise<SubscriptionResponse> {
    const [usage, entry, plans] = await Promise.all([
      this.freeTierUsage(shop.id),
      this.billing.entryPlan(),
      this.billing.plans(),
    ]);
    return SubscriptionResponse.freeTier(shop, {
      ordersCount: usage.ordersCount,
      ordersCap: FREE_ORDER_CAP,
      productsCount: usage.productsCount,
      maxProducts: FREE_MAX_PRODUCTS,
      entryPlan: entry,
      plans,
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
    // The period being paid for is the first one not yet bought, so a parked
    // downgrade (or auto-reset) applies to it — the seller pays that plan's
    // price from here.
    const rollover = await this.rolloverPlan(sub);
    const chargeCents = rollover?.priceCents ?? sub.amountCents;
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
        // A new period is a fresh sales allowance.
        capExceededAt: null,
        ...(rollover && {
          planCode: rollover.code,
          amountCents: rollover.priceCents,
          scheduledPlanCode: null,
        }),
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
      planCode: updated.planCode,
      amountCents: Math.max(0, chargeCents - sub.pendingDiscountCents),
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
    // Resuming into a fresh month starts the plan the next period would have
    // started on — a parked downgrade, or the entry plan under auto-reset.
    // Resuming inside a period they already paid for changes nothing yet.
    const rollover = lapsed ? await this.rolloverPlan(sub) : null;
    const chargeCents = rollover?.priceCents ?? sub.amountCents;
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
              capExceededAt: null,
              ...(rollover && {
                planCode: rollover.code,
                amountCents: rollover.priceCents,
                scheduledPlanCode: null,
              }),
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
        planCode: reactivated.planCode,
        amountCents: Math.max(0, chargeCents - sub.pendingDiscountCents),
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

  // ── Plan ladder ────────────────────────────────────────────────

  /**
   * The billing period the sales meter measures: the month ending on the
   * scheduled payment date. A past_due shop keeps measuring the period it
   * last paid for until the dues clear, which is also the period its cap
   * applies to.
   */
  private periodWindow(sub: SubscriptionRow): { start: Date; end: Date } {
    // Invariant this relies on: `nextBillingAt` always sits on the anchor day,
    // so stepping one month back lands exactly on the previous billing date.
    // Every writer preserves it — the anchor only ever advances through
    // `addOneMonth`, and the two places that re-anchor (`activateForNewShop`,
    // a lapsed `resume`) set `startedAt` in the same breath. Write an
    // off-anchor date straight into the column and this window drifts, so
    // don't (see the note on hand-seeding billing dates in test data).
    const anchorDay = sub.startedAt.getDate();
    return {
      start: subOneMonth(sub.nextBillingAt, anchorDay),
      end: sub.nextBillingAt,
    };
  }

  /**
   * What the shop sold in one window: the value of every order placed in it
   * that wasn't cancelled. Cancelled orders never counted against the cap, so
   * cancelling one gives the allowance back.
   */
  private async periodSalesCents(
    shopId: string,
    start: Date,
    end: Date,
  ): Promise<number> {
    const [row] = await this.db
      .select({ total: sql<string>`coalesce(sum(${orders.totalCents}), 0)` })
      .from(orders)
      .where(
        and(
          eq(orders.shopId, shopId),
          ne(orders.status, 'Cancelled'),
          gte(orders.placedAt, start),
          lt(orders.placedAt, end),
        ),
      );
    return Number(row?.total ?? 0);
  }

  /**
   * Move a shop along the plan ladder.
   *
   * Up is instant: the shop is on the new plan the moment this returns, and
   * pays only the difference for the days left in the period it already
   * bought. The billing date never moves.
   *
   * Down is parked: the seller keeps the plan they paid for until it expires,
   * and the cheaper plan takes over at the next renewal. Picking the current
   * plan again cancels a parked downgrade.
   */
  async changePlan(
    shopId: string,
    code: string,
  ): Promise<SubscriptionResponse> {
    const sub = await this.settle(await this.requireByShop(shopId));
    if (sub.status === 'cancelled') {
      throw new ForbiddenException(
        'This subscription is cancelled. Resume it before changing plan.',
      );
    }
    const sellable = await this.billing.plans();
    const target = sellable.find((p) => p.code === code);
    if (!target) {
      throw new BadRequestException('That plan is not available.');
    }

    // Same plan: the seller changed their mind about a parked downgrade.
    if (target.code === sub.planCode) {
      if (!sub.scheduledPlanCode) {
        return this.toResponse(sub);
      }
      const [cleared] = await this.db
        .update(subscriptions)
        .set({ scheduledPlanCode: null })
        .where(eq(subscriptions.id, sub.id))
        .returning();
      return this.toResponse(cleared);
    }

    const current = await this.billing.planByCode(sub.planCode);
    if (target.priceCents > current.priceCents) {
      return this.toResponse(await this.applyUpgrade(sub, target, 'manual'));
    }

    const [scheduled] = await this.db
      .update(subscriptions)
      .set({ scheduledPlanCode: target.code })
      .where(eq(subscriptions.id, sub.id))
      .returning();
    return this.toResponse(scheduled);
  }

  /**
   * Enable or disable auto-scale. Turning it on evaluates the cap straight
   * away, so a shop already over its allowance moves up immediately rather
   * than waiting for the next sweep. Turning it off also switches auto-reset
   * off: without auto-scale nothing would ever lift the shop back up, so a
   * lone auto-reset would strand it on the entry plan.
   */
  async setAutoScale(
    shopId: string,
    enabled: boolean,
  ): Promise<SubscriptionResponse> {
    const sub = await this.settle(await this.requireByShop(shopId));
    if (sub.autoScale === enabled) {
      return this.toResponse(sub);
    }
    const [updated] = await this.db
      .update(subscriptions)
      .set({ autoScale: enabled, ...(enabled ? {} : { autoReset: false }) })
      .where(eq(subscriptions.id, sub.id))
      .returning();
    return this.toResponse(await this.enforceCap(updated));
  }

  /**
   * Enable or disable auto-reset — "start every month on the entry plan".
   * Only meaningful alongside auto-scale, which is what climbs back up, so
   * enabling it without auto-scale is refused rather than silently ignored.
   * Nothing is charged or changed today: the reset lands on the next
   * billing date.
   */
  async setAutoReset(
    shopId: string,
    enabled: boolean,
  ): Promise<SubscriptionResponse> {
    const sub = await this.settle(await this.requireByShop(shopId));
    if (enabled && !sub.autoScale) {
      throw new BadRequestException(
        'Turn on auto-scale first — without it nothing would move your shop back up after a reset.',
      );
    }
    if (sub.autoReset === enabled) {
      return this.toResponse(sub);
    }
    const [updated] = await this.db
      .update(subscriptions)
      .set({ autoReset: enabled })
      .where(eq(subscriptions.id, sub.id))
      .returning();
    return this.toResponse(updated);
  }

  /**
   * Which plan the *next* billing period starts on, or null to stay put.
   *
   * A downgrade the seller picked by hand wins — it is an explicit choice for
   * that period. Otherwise auto-reset drops the shop back to the entry plan,
   * from which auto-scale climbs again as the new month's sales arrive.
   */
  private async rolloverPlan(sub: SubscriptionRow): Promise<PlanView | null> {
    if (sub.scheduledPlanCode) {
      return this.billing.planByCode(sub.scheduledPlanCode);
    }
    if (!sub.autoReset) {
      return null;
    }
    const entry = await this.billing.entryPlan();
    return entry.code === sub.planCode ? null : entry;
  }

  /**
   * Put a subscription on a dearer plan now and charge the prorated
   * difference for the rest of the current period. `method` records whether
   * the seller pressed the button or auto-scale did it for them.
   */
  private async applyUpgrade(
    sub: SubscriptionRow,
    plan: PlanView,
    method: 'auto' | 'manual',
  ): Promise<SubscriptionRow> {
    const now = new Date();
    const { start, end } = this.periodWindow(sub);
    // Days already paid for at the old price cost nothing extra; an overdue
    // period has no days left, so the upgrade is free until the renewal.
    const remainingMs = Math.max(0, end.getTime() - now.getTime());
    const periodMs = Math.max(1, end.getTime() - start.getTime());
    const deltaCents = Math.max(0, plan.priceCents - sub.amountCents);
    const chargeCents = Math.round((deltaCents * remainingMs) / periodMs);

    // Guarded on the plan we based the proration on: a double-submitted
    // upgrade (or a sweep racing the console) charges the difference once.
    const [updated] = await this.db
      .update(subscriptions)
      .set({
        planCode: plan.code,
        amountCents: plan.priceCents,
        // Moving up satisfies whatever the shop had outstanding, and clears
        // any downgrade the seller had parked.
        scheduledPlanCode: null,
        capExceededAt: null,
      })
      .where(
        and(
          eq(subscriptions.id, sub.id),
          eq(subscriptions.planCode, sub.planCode),
        ),
      )
      .returning();
    if (!updated) {
      const fresh = await this.db.query.subscriptions.findFirst({
        where: eq(subscriptions.id, sub.id),
      });
      return fresh ?? sub;
    }

    if (chargeCents > 0) {
      await this.db.insert(subscriptionPayments).values({
        userId: sub.ownerId,
        subscriptionId: sub.id,
        shopId: sub.shopId,
        type: 'upgrade',
        method,
        planCode: plan.code,
        amountCents: chargeCents,
        currency: sub.currency,
        periodStart: now,
        periodEnd: end,
        paidAt: now,
      });
    }
    this.logger.log(
      `Subscription ${sub.id} upgraded to ${plan.code} (${method}), charged ${chargeCents / 100} BDT prorated`,
    );
    // Only lift a pause this system caused: the shop was forced offline
    // because its grace over the old cap ran out, and the upgrade fixes
    // exactly that. A storefront the seller switched off themselves — or one
    // parked for unpaid dues — stays off.
    const pausedByCap =
      sub.status === 'active' &&
      !!sub.capExceededAt &&
      now.getTime() - sub.capExceededAt.getTime() > CAP_GRACE_MS;
    if (pausedByCap) {
      await this.db
        .update(shops)
        .set({ live: true })
        .where(and(eq(shops.id, sub.shopId), eq(shops.live, false)));
    }
    return updated;
  }

  /**
   * Compare the period's sales with the plan's cap and act on the result.
   *
   * Over the cap with auto-scale on: move up a rung (repeatedly, if a very
   * big month jumps two). Over it with auto-scale off: start the grace clock
   * and, once it runs out, pause the storefront until the seller upgrades or
   * the period rolls over. Back under the cap (an order was cancelled): stop
   * the clock.
   */
  private async enforceCap(sub: SubscriptionRow): Promise<SubscriptionRow> {
    if (sub.status === 'cancelled') {
      return sub;
    }
    const plan = await this.billing.planByCode(sub.planCode);
    if (plan.salesCapCents === null) {
      // Top of the ladder — nothing to enforce, so no clock should be running.
      return sub.capExceededAt ? this.clearCapClock(sub) : sub;
    }
    const { start, end } = this.periodWindow(sub);
    const sales = await this.periodSalesCents(sub.shopId, start, end);
    if (sales < plan.salesCapCents) {
      return sub.capExceededAt ? this.clearCapClock(sub) : sub;
    }

    if (sub.autoScale) {
      const next = await this.billing.nextPlanUp(plan.code);
      if (next) {
        // Each hop strictly climbs the ladder, so this terminates at the top.
        return this.enforceCap(await this.applyUpgrade(sub, next, 'auto'));
      }
    }

    const now = new Date();
    let current = sub;
    if (!current.capExceededAt) {
      const [started] = await this.db
        .update(subscriptions)
        .set({ capExceededAt: now })
        .where(
          and(
            eq(subscriptions.id, sub.id),
            isNull(subscriptions.capExceededAt),
          ),
        )
        .returning();
      current = started ?? current;
      this.logger.log(
        `Shop ${sub.shopId} passed the ${plan.code} sales cap — grace started`,
      );
    }
    const since = current.capExceededAt ?? now;
    if (now.getTime() - since.getTime() > CAP_GRACE_MS) {
      await this.db
        .update(shops)
        .set({ live: false })
        .where(and(eq(shops.id, sub.shopId), eq(shops.live, true)));
    }
    return current;
  }

  private async clearCapClock(sub: SubscriptionRow): Promise<SubscriptionRow> {
    const [cleared] = await this.db
      .update(subscriptions)
      .set({ capExceededAt: null })
      .where(eq(subscriptions.id, sub.id))
      .returning();
    return cleared ?? sub;
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
   * (paid plan) or free orders left in the trial (free plan).
   */
  async setShopLive(shopId: string, live: boolean): Promise<{ live: boolean }> {
    if (live) {
      const shop = await this.requireShop(shopId);
      if (shop.plan === 'free') {
        const usage = await this.freeTierUsage(shopId);
        if (usage.ordersCount >= FREE_ORDER_CAP) {
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
   * Bring a subscription up to date, then check it against its plan's sales
   * cap. Both run on every console read and on the hourly sweep, so a shop is
   * never more than an hour behind either.
   */
  private async settle(sub: SubscriptionRow): Promise<SubscriptionRow> {
    return this.enforceCap(await this.settleBilling(sub));
  }

  /**
   * The billing half. While the due date is in the past: auto-debit collects
   * each elapsed period (dummy gateway — always succeeds) and rolls the
   * anchor forward; without auto-debit the sub is parked in past_due until
   * the seller pays manually. A period that rolls over also applies any
   * parked downgrade and resets the sales meter.
   */
  private async settleBilling(sub: SubscriptionRow): Promise<SubscriptionRow> {
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

    // A parked downgrade — or auto-reset — takes effect with the first period
    // the shop hasn't paid for, so the renewals collected below are charged at
    // that plan's price, not the one the seller is leaving.
    const rollover = collected.length > 0 ? await this.rolloverPlan(sub) : null;
    const chargeCents = rollover?.priceCents ?? sub.amountCents;

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
          // A new period is a fresh sales allowance: whatever cap breach the
          // old one ended on no longer applies.
          capExceededAt: null,
          ...(rollover && {
            planCode: rollover.code,
            amountCents: rollover.priceCents,
            scheduledPlanCode: null,
          }),
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
          planCode: updated.planCode,
          amountCents:
            // A coupon bought at the old price can't exceed a cheaper new
            // one — the renewal must never be a refund.
            Math.max(0, chargeCents - (i === 0 ? sub.pendingDiscountCents : 0)),
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

  /**
   * Background sweep over every non-cancelled subscription: collects what is
   * due and checks each shop against its plan's sales cap. The cap half is
   * why this can't be narrowed to subscriptions that are due — a shop that
   * outgrows its plan mid-period has nothing due at all.
   */
  private async sweepDueSubscriptions(): Promise<void> {
    try {
      const live = await this.db.query.subscriptions.findMany({
        where: ne(subscriptions.status, 'cancelled'),
      });
      for (const sub of live) {
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
    const entry = await this.billing.entryPlan();
    const [created] = await this.db
      .insert(subscriptions)
      .values({
        shopId,
        ownerId: shop.ownerId,
        status: 'active',
        planCode: entry.code,
        amountCents: entry.priceCents,
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
    const { start, end } = this.periodWindow(sub);
    const [shop, payments, plan, plans, entryPlan, salesCents] =
      await Promise.all([
        this.db.query.shops.findFirst({
          where: eq(shops.id, sub.shopId),
          columns: { live: true },
        }),
        this.db.query.subscriptionPayments.findMany({
          where: eq(subscriptionPayments.subscriptionId, sub.id),
          orderBy: [desc(subscriptionPayments.paidAt)],
        }),
        this.billing.planByCode(sub.planCode),
        this.billing.plans(),
        this.billing.entryPlan(),
        this.periodSalesCents(sub.shopId, start, end),
      ]);
    const scheduled = sub.scheduledPlanCode
      ? (plans.find((p) => p.code === sub.scheduledPlanCode) ?? null)
      : null;
    // What the next renewal will actually bill for — a parked downgrade or an
    // auto-reset changes it, so the console must not quote today's price.
    const nextPlan = await this.rolloverPlan(sub);
    return SubscriptionResponse.fromRows(sub, shop?.live ?? false, payments, {
      plan,
      plans,
      scheduledPlan: scheduled,
      nextPlan,
      entryPlan,
      salesCents,
      periodStart: start,
      periodEnd: end,
      graceMs: CAP_GRACE_MS,
    });
  }
}
