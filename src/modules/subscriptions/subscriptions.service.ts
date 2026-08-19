import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { and, desc, eq, gte, isNull, lt, ne, sql } from 'drizzle-orm';
import {
  COMMISSION_DUE_GRACE_MS,
  CREDIT_BALANCE_CAP_CENTS,
  FREE_ORDER_CAP,
  FREE_TIER_LIMIT_MESSAGE,
  PLATFORM_CURRENCY,
} from '../../common/constants/billing';
import { DRIZZLE } from '../../database/database.constants';
import type { DbExecutor, DrizzleDB } from '../../database/drizzle.types';
import {
  orders,
  shops,
  subscriptionPayments,
  subscriptions,
  type ShopRow,
  type SubscriptionRow,
} from '../../database/schema';
import {
  BillingSettingsService,
  type CreditPackView,
} from '../billing/billing-settings.service';
import { CouponsService } from '../coupons/coupons.service';
import {
  GatewayCheckoutService,
  type CollectingGateway,
} from '../gateways/gateway-checkout.service';
import { ReferralsService } from '../referrals/referrals.service';
import {
  FreeTierUsageResponse,
  SubscriptionResponse,
} from './dto/subscription.response';

export { PLATFORM_CURRENCY };

/**
 * What buying a credit pack returns. `paymentUrl` set means the seller has
 * to finish on the gateway's page and nothing has been granted yet;
 * `subscription` is the state as it stands either way.
 */
export interface BuyCreditsResult {
  paymentUrl: string | null;
  subscription: SubscriptionResponse;
}

/**
 * Where a shop stands with the platform right now, for the flows that need
 * to know before they let it go: deleting a shop is refused while post-paid
 * commission is unpaid, and warns about pre-paid credit it would forfeit.
 */
export interface ClosingPosition {
  /** Post-paid commission still to pay: the part-month plus any issued bill. */
  commissionOwedCents: number;
  /** Pre-paid credit bought and not yet sold through - lost with the shop. */
  creditBalanceCents: number;
  currency: string;
}

/** What a verified shop owes if its billing stopped right now. */
interface CommissionOwed {
  periodStart: Date;
  billableSalesCents: number;
  /** Commission on the month part-way through. */
  accruedCents: number;
  /** A bill already issued and still unpaid. */
  dueCents: number;
  total: number;
}

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

/** The mirror of `addOneMonth`: one calendar month before `from`. */
function subOneMonth(from: Date, anchorDay: number): Date {
  const prev = new Date(from);
  const year = prev.getFullYear();
  const month = prev.getMonth() - 1;
  const lastDay = new Date(year, month + 1, 0).getDate();
  prev.setFullYear(year, month, Math.min(anchorDay, lastDay));
  return prev;
}

/**
 * What a shop owes the platform for the sales it makes, on one of two tracks.
 *
 * **Credits** (everyone). The shop buys sales credit up front; each taka it
 * sells draws the balance down. Nothing is billed monthly because it has
 * already been paid. When the balance runs out the storefront pauses until the
 * seller tops up.
 *
 * **Commission** (verified trade licence only). Nothing up front; at each
 * monthly anchor the shop is billed a flat rate on what it sold that month.
 *
 * Credit is spent first on *either* track, which is what makes moving to the
 * verified track lossless: a shop that bought ৳10,00,000 of credit still sells
 * that ৳10,00,000 for nothing extra, and commission only starts being charged
 * on sales beyond it.
 */
@Injectable()
export class SubscriptionsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SubscriptionsService.name);
  private sweepTimer?: NodeJS.Timeout;

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly coupons: CouponsService,
    private readonly billing: BillingSettingsService,
    private readonly referrals: ReferralsService,
    private readonly gatewayCheckout: GatewayCheckoutService,
  ) {}

  onModuleInit(): void {
    // Hourly sweep. Reads also settle lazily, so this only exists to keep
    // billing moving while nobody is looking at the console.
    this.sweepTimer = setInterval(() => {
      void this.sweepDueSubscriptions();
    }, BILLING_SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
    void this.sweepDueSubscriptions();
  }

  onModuleDestroy(): void {
    clearInterval(this.sweepTimer);
  }

  // ── Opening a shop ─────────────────────────────────────────────

  /**
   * Called by the create-shop flow. Creating a shop is free, so this only
   * opens the billing record: the credits track with a zero balance, its
   * meter starting now. The shop stays on the free trial until the seller
   * buys their first pack.
   */
  async openForNewShop(
    userId: string,
    shopId: string,
  ): Promise<SubscriptionRow> {
    const now = new Date();
    // Snapshotted now and re-snapshotted whenever the shop joins the verified
    // track, so a rate change never has to walk every credits shop.
    const bps = await this.billing.commissionBps();
    const [sub] = await this.db
      .insert(subscriptions)
      .values({
        shopId,
        ownerId: userId,
        status: 'active',
        billingMode: 'credits',
        currency: PLATFORM_CURRENCY,
        commissionBps: bps,
        creditGrantedCents: 0,
        meterStartAt: now,
        startedAt: now,
        nextBillingAt: addOneMonth(now, now.getDate()),
      })
      .returning();
    return sub;
  }

  // ── Console view ───────────────────────────────────────────────

  /** The Subscription page: settles what's due, then renders the state. */
  async getForShop(shopId: string): Promise<SubscriptionResponse> {
    const sub = await this.findByShop(shopId);
    if (!sub) {
      // A shop from before this system that has never been touched.
      const shop = await this.requireShop(shopId);
      const [freeTier, packs] = await Promise.all([
        this.freeTierUsage(shopId),
        this.billing.packs(),
      ]);
      return SubscriptionResponse.bare(shop, {
        freeTier,
        packs,
        creditCapCents: CREDIT_BALANCE_CAP_CENTS,
      });
    }
    return this.toResponse(await this.settle(sub));
  }

  // ── The credits track ──────────────────────────────────────────

  /**
   * What a shop has bought and what it has left. Usage is not a stored
   * counter: it is the value of the shop's non-cancelled orders since the
   * meter started, so cancelling an order hands its allowance straight back
   * and nothing can drift out of sync with the orders table.
   */
  private async creditState(sub: SubscriptionRow): Promise<{
    granted: number;
    used: number;
    balance: number;
  }> {
    const used = await this.salesCents(
      sub.shopId,
      sub.meterStartAt,
      new Date(),
    );
    return {
      granted: sub.creditGrantedCents,
      used,
      balance: Math.max(0, sub.creditGrantedCents - used),
    };
  }

  /**
   * Buy a credit pack. The balance ceiling is enforced here rather than at
   * the catalogue: a seller may hold at most `CREDIT_BALANCE_CAP_CENTS` of
   * credit, so a pack is only sellable while the balance plus what it grants
   * stays inside that. Selling credit down opens the room back up.
   *
   * An optional coupon discounts the purchase. An invalid code fails the
   * whole purchase with a 400 rather than silently charging full price; a
   * valid one is only *redeemed* once the money lands, so abandoning the
   * payment page does not burn the seller's one use of it.
   *
   * Returns a `paymentUrl` to send the seller to the gateway. Credit is not
   * granted here - see {@link grantPurchasedCredit}. The exception is a
   * purchase a coupon has made free, which has nothing to collect and is
   * granted on the spot.
   */
  async buyCredits(
    shopId: string,
    packCode: string,
    couponCode?: string,
    refSlug?: string,
    gateway?: CollectingGateway,
  ): Promise<BuyCreditsResult> {
    const sub = await this.settle(await this.requireByShop(shopId));
    if (sub.status === 'cancelled') {
      throw new ForbiddenException(
        'This shop is cancelled. Resume it before buying credit.',
      );
    }
    const pack = await this.billing.packByCode(packCode);
    if (!pack || !pack.active) {
      throw new BadRequestException('That credit pack is not available.');
    }

    const { balance } = await this.creditState(sub);
    if (balance + pack.salesCreditCents > CREDIT_BALANCE_CAP_CENTS) {
      const room = Math.max(0, CREDIT_BALANCE_CAP_CENTS - balance);
      throw new BadRequestException(
        room <= 0
          ? `You are holding the maximum ৳${(CREDIT_BALANCE_CAP_CENTS / 100).toLocaleString('en-US')} of sales credit. Sell some of it before buying more.`
          : `This pack would put you over the ৳${(CREDIT_BALANCE_CAP_CENTS / 100).toLocaleString('en-US')} credit limit - you have room for ৳${(room / 100).toLocaleString('en-US')} more right now.`,
      );
    }

    let coupon: { id: string; code: string } | undefined;
    let discountCents = 0;
    if (couponCode?.trim()) {
      const check = await this.coupons.check(
        couponCode,
        sub.ownerId,
        pack.priceCents,
      );
      if (!check.ok) {
        throw new BadRequestException(
          this.coupons.rejectionMessage(check.reason),
        );
      }
      coupon = check.coupon;
      discountCents = check.discountCents;
    }

    const amountDueCents = Math.max(0, pack.priceCents - discountCents);

    // A coupon can take the price to nothing, and there is no sense sending
    // someone to a payment page to pay zero - grant it on the spot.
    if (amountDueCents === 0) {
      const granted = await this.applyCreditPurchase({
        sub,
        pack,
        amountCents: 0,
        discountCents,
        couponCode: coupon?.code ?? null,
        refSlug: refSlug ?? null,
        gateway: null,
        paymentTransactionId: null,
      });
      return {
        paymentUrl: null,
        subscription: await this.toResponseFor(granted),
      };
    }

    // Everything else is real money, collected on the platform's own gateway
    // account. Nothing is granted here: the session records what was bought,
    // and the credit lands only once the money does (PaymentsService).
    const available = await this.gatewayCheckout.available();
    if (!available.length) {
      throw new BadRequestException(
        'Online payment is not available right now - please try again shortly.',
      );
    }
    const chosen =
      gateway && available.includes(gateway) ? gateway : available[0];
    if (gateway && !available.includes(gateway)) {
      throw new BadRequestException(
        `${this.gatewayCheckout.label(gateway)} is not available right now - please pick another method.`,
      );
    }

    const shop = await this.db.query.shops.findFirst({
      where: eq(shops.id, sub.shopId),
      columns: {
        name: true,
        supportPhone: true,
        pickupPhone: true,
        pickupAddress: true,
      },
      with: { owner: { columns: { name: true, email: true, phone: true } } },
    });
    const owner = (
      shop as
        | { owner?: { name: string; email: string; phone: string | null } }
        | undefined
    )?.owner;

    const { paymentUrl } = await this.gatewayCheckout.open({
      purpose: 'credit_pack',
      gateway: chosen,
      amountCents: amountDueCents,
      reference: 'CREDIT',
      entityId: sub.shopId,
      productName: `${pack.name} sales credit`,
      shopId: sub.shopId,
      packCode: pack.code,
      couponCode: coupon?.code,
      discountCents,
      refSlug,
      customer: {
        name: owner?.name ?? shop?.name ?? 'Seller',
        email: owner?.email ?? '',
        phone: owner?.phone ?? shop?.pickupPhone ?? shop?.supportPhone ?? '',
        address: shop?.pickupAddress ?? shop?.name ?? 'N/A',
        city: 'Dhaka',
        postcode: '1000',
      },
    });
    return { paymentUrl, subscription: await this.toResponseFor(sub) };
  }

  /** The shop owner's account id - who a credit-pack payment belongs to. */
  async ownerIdForShop(shopId: string): Promise<string | null> {
    const sub = await this.db.query.subscriptions.findFirst({
      where: eq(subscriptions.shopId, shopId),
      columns: { ownerId: true },
    });
    return sub?.ownerId ?? null;
  }

  /**
   * Hand over the credit a seller has now actually paid for. Called by the
   * payments flow when the gateway confirms, never from the buy endpoint -
   * which is the whole point of routing credit through a hosted checkout:
   * an abandoned or failed purchase grants nothing.
   */
  async grantPurchasedCredit(
    attempt: {
      shopId: string | null;
      packCode: string | null;
      amountCents: number;
      discountCents: number;
      couponCode: string | null;
      refSlug: string | null;
      provider: string;
    },
    charge: { transactionId: string | null; gatewayTxnId: string },
  ): Promise<void> {
    if (!attempt.shopId || !attempt.packCode) {
      this.logger.error(
        'A credit-pack payment settled without a shop or pack on the session',
      );
      return;
    }
    const sub = await this.db.query.subscriptions.findFirst({
      where: eq(subscriptions.shopId, attempt.shopId),
    });
    const pack = await this.billing.packByCode(attempt.packCode);
    if (!sub || !pack) {
      this.logger.error(
        `Cannot grant credit for shop ${attempt.shopId}: ${!sub ? 'no subscription' : 'pack ' + attempt.packCode + ' is gone'}`,
      );
      return;
    }
    await this.applyCreditPurchase({
      sub,
      pack,
      amountCents: attempt.amountCents,
      discountCents: attempt.discountCents,
      couponCode: attempt.couponCode,
      refSlug: attempt.refSlug,
      gateway: attempt.provider,
      paymentTransactionId: charge.transactionId,
      gatewayTxnId: charge.gatewayTxnId,
    });
  }

  /**
   * Grant a pack's credit and write the ledger row. The one place credit is
   * ever created, so the free-coupon path and the paid path cannot drift.
   *
   * The ledger keeps the pack's *name* as well as its code: a seller reading
   * their own history recognises "Growth", not "credit-200k", and the
   * catalogue row can be renamed or retired underneath them.
   */
  private async applyCreditPurchase(input: {
    sub: SubscriptionRow;
    pack: CreditPackView;
    amountCents: number;
    discountCents: number;
    couponCode: string | null;
    refSlug: string | null;
    gateway: string | null;
    paymentTransactionId: string | null;
    gatewayTxnId?: string | null;
  }): Promise<SubscriptionRow> {
    const { sub, pack } = input;
    const [updated] = await this.db
      .update(subscriptions)
      .set({
        creditGrantedCents: sub.creditGrantedCents + pack.salesCreditCents,
        // Topping up is what un-pauses a shop that sold through its balance.
        creditExhaustedAt: null,
      })
      .where(
        and(
          eq(subscriptions.id, sub.id),
          eq(subscriptions.creditGrantedCents, sub.creditGrantedCents),
        ),
      )
      .returning();
    if (!updated) {
      throw new ConflictException(
        'This purchase was just completed - refresh to see your balance.',
      );
    }

    // The coupon is only redeemed now, when the money is in - a seller who
    // abandoned the payment page has not spent their one use of it.
    let couponId: string | undefined;
    if (input.couponCode) {
      const check = await this.coupons.check(
        input.couponCode,
        sub.ownerId,
        pack.priceCents,
      );
      if (check.ok) couponId = check.coupon.id;
    }

    await this.db.insert(subscriptionPayments).values({
      userId: sub.ownerId,
      subscriptionId: sub.id,
      shopId: sub.shopId,
      type: 'credit_pack',
      method: 'manual',
      planCode: pack.code,
      planName: pack.name,
      amountCents: input.amountCents,
      salesCreditCents: pack.salesCreditCents,
      currency: sub.currency,
      couponId,
      couponCode: input.couponCode ?? undefined,
      discountCents: input.discountCents,
      gateway: input.gateway,
      paymentTransactionId: input.paymentTransactionId,
      gatewayTxnId: input.gatewayTxnId ?? null,
    });

    if (couponId) {
      await this.coupons.markRedeemed(couponId);
      // Attribution only - recordSignup never throws and only counts when the
      // slug still maps to the coupon that was actually redeemed.
      if (input.refSlug?.trim()) {
        await this.referrals.recordSignup(input.refSlug, couponId);
      }
    }

    // Buying credit ends the free trial: real credit, real limits lifted.
    await this.db
      .update(shops)
      .set({ plan: 'paid', live: true })
      .where(eq(shops.id, sub.shopId));

    this.logger.log(
      `Shop ${sub.shopId} bought ${pack.code}: ${pack.salesCreditCents / 100} BDT of selling for ${input.amountCents / 100} BDT${input.gateway ? ` via ${input.gateway}` : ' (free)'}`,
    );
    return updated;
  }

  /** Re-settle and shape one subscription for the API. */
  private async toResponseFor(
    sub: SubscriptionRow,
  ): Promise<SubscriptionResponse> {
    return this.toResponse(await this.settle(sub));
  }

  // ── Switching tracks ───────────────────────────────────────────

  /**
   * Move between the two tracks. Commission is gated on the shop's trade
   * licence being verified - that is the whole difference between the tracks.
   * Credit already bought is never touched by the move; it is simply spent
   * before commission starts being charged.
   */
  async setBillingMode(
    shopId: string,
    mode: 'credits' | 'commission',
  ): Promise<SubscriptionResponse> {
    const sub = await this.settle(await this.requireByShop(shopId));
    if (sub.status === 'cancelled') {
      throw new ForbiddenException(
        'This shop is cancelled. Resume it before changing how you pay.',
      );
    }
    if (sub.billingMode === mode) {
      return this.toResponse(sub);
    }
    const shop = await this.requireShop(shopId);

    if (mode === 'commission') {
      if (shop.kycStatus !== 'verified') {
        throw new ForbiddenException(
          shop.kycStatus === 'pending'
            ? 'Your trade licence is still being reviewed. Post-paid billing opens as soon as it is verified.'
            : 'Post-paid billing is for verified merchants - submit your trade licence to unlock it.',
        );
      }
      // The month starts counting from the switch, not from whatever anchor
      // the shop was carrying, so the first bill only covers verified days.
      const now = new Date();
      const [switched] = await this.db
        .update(subscriptions)
        .set({
          billingMode: 'commission',
          // Today's operator rate. `updateCommissionBps` re-rates live
          // post-paid shops, so this stays in step afterwards.
          commissionBps: await this.billing.commissionBps(),
          startedAt: now,
          nextBillingAt: addOneMonth(now, now.getDate()),
          // A commission shop is never paused for an empty balance.
          creditExhaustedAt: null,
        })
        .where(eq(subscriptions.id, sub.id))
        .returning();
      // Post-paid means it can sell before it has paid anything.
      await this.db
        .update(shops)
        .set({ plan: 'paid' })
        .where(eq(shops.id, shopId));
      this.logger.log(`Shop ${shopId} moved to the commission track`);
      return this.toResponse(await this.settle(switched));
    }

    // Leaving the verified track closes the month that is part-way through.
    // The shop has been selling on credit it hasn't paid for yet, so that
    // commission is settled on the way out - otherwise a seller could take a
    // month of orders post-paid and hop back to pre-paid owing nothing.
    const now = new Date();
    const owed = await this.commissionOwed(sub, now);
    if (owed.total > 0) {
      const [settled] = await this.db
        .update(subscriptions)
        .set({
          billingMode: 'credits',
          dueCents: 0,
          dueSince: null,
          duePeriodStart: null,
          duePeriodEnd: null,
          dueBillableSalesCents: null,
          status: 'active',
          // The next stint on the verified track starts a fresh month, so
          // nothing billed here can be billed again.
          startedAt: now,
          nextBillingAt: addOneMonth(now, now.getDate()),
        })
        .where(
          and(
            eq(subscriptions.id, sub.id),
            eq(subscriptions.billingMode, 'commission'),
          ),
        )
        .returning();
      if (!settled) {
        throw new ConflictException(
          'Your billing just changed - refresh to see the latest state.',
        );
      }
      await this.recordClosingCommission(sub, owed, now);
      // Paying up lifts a pause the unpaid bill caused.
      await this.liftPause(sub.shopId);
      this.logger.log(
        `Shop ${shopId} moved back to the credits track, settling ${owed.total / 100} BDT of commission`,
      );
      return this.toResponse(await this.settle(settled));
    }

    const [switched] = await this.db
      .update(subscriptions)
      .set({
        billingMode: 'credits',
        startedAt: now,
        nextBillingAt: addOneMonth(now, now.getDate()),
      })
      .where(eq(subscriptions.id, sub.id))
      .returning();
    this.logger.log(`Shop ${shopId} moved back to the credits track`);
    return this.toResponse(await this.settle(switched));
  }

  /**
   * Write the ledger rows for a commission position being closed out: one for
   * the part-month just ended, one for anything already issued and still
   * unpaid, so the two stay distinguishable in the seller's history.
   *
   * Takes an executor so a shop deletion can record the charge inside the same
   * transaction that removes the shop.
   */
  private async recordClosingCommission(
    sub: SubscriptionRow,
    owed: CommissionOwed,
    now: Date,
    executor: DbExecutor = this.db,
  ): Promise<void> {
    if (owed.accruedCents > 0) {
      await executor.insert(subscriptionPayments).values({
        userId: sub.ownerId,
        subscriptionId: sub.id,
        shopId: sub.shopId,
        type: 'commission',
        method: 'manual',
        amountCents: owed.accruedCents,
        billableSalesCents: owed.billableSalesCents,
        currency: sub.currency,
        periodStart: owed.periodStart,
        periodEnd: now,
        paidAt: now,
      });
    }
    if (owed.dueCents > 0) {
      await executor.insert(subscriptionPayments).values({
        userId: sub.ownerId,
        subscriptionId: sub.id,
        shopId: sub.shopId,
        type: 'commission',
        method: 'manual',
        amountCents: owed.dueCents,
        billableSalesCents: sub.dueBillableSalesCents,
        currency: sub.currency,
        periodStart: sub.duePeriodStart,
        periodEnd: sub.duePeriodEnd,
        paidAt: now,
      });
    }
  }

  /**
   * Bill whatever a shop owes on the verified track before it stops selling -
   * cancelling or being deleted. Without this, a merchant could sell all month
   * post-paid and close the shop on the last day owing nothing: `settle()`
   * skips cancelled subscriptions, so the month would never be billed.
   *
   * Safe to call for a credits shop or one that owes nothing; it does nothing.
   */
  async settleOnClose(
    shopId: string,
    executor: DbExecutor = this.db,
  ): Promise<number> {
    const sub = await executor.query.subscriptions.findFirst({
      where: eq(subscriptions.shopId, shopId),
    });
    if (
      !sub ||
      sub.status === 'cancelled' ||
      sub.billingMode !== 'commission'
    ) {
      return 0;
    }
    const now = new Date();
    const owed = await this.commissionOwed(sub, now, executor);
    if (owed.total <= 0) {
      return 0;
    }
    await this.recordClosingCommission(sub, owed, now, executor);
    await executor
      .update(subscriptions)
      .set({
        dueCents: 0,
        dueSince: null,
        duePeriodStart: null,
        duePeriodEnd: null,
        dueBillableSalesCents: null,
      })
      .where(eq(subscriptions.id, sub.id));
    this.logger.log(
      `Shop ${shopId} closed owing ${owed.total / 100} BDT of commission - billed`,
    );
    return owed.total;
  }

  /**
   * The two numbers that decide whether a shop can be deleted: what it still
   * owes us on the post-paid track (which blocks the delete until it is paid),
   * and the pre-paid credit it would walk away from (which only warns).
   *
   * Settles first, so a bill that fell due while nobody was looking is part of
   * the figure rather than arriving after the seller agreed to delete.
   */
  async closingPosition(shopId: string): Promise<ClosingPosition> {
    const sub = await this.findByShop(shopId);
    if (!sub) {
      return {
        commissionOwedCents: 0,
        creditBalanceCents: 0,
        currency: PLATFORM_CURRENCY,
      };
    }
    const current = await this.settle(sub);
    // Mirrors what `settleOnClose` would actually bill: a cancelled shop has
    // already been settled, and a credits shop is paid up by definition.
    const commissionOwedCents =
      current.status !== 'cancelled' && current.billingMode === 'commission'
        ? (await this.commissionOwed(current, new Date())).total
        : 0;
    // Credit is spent first on either track, so leftover credit is forfeited
    // whichever track the shop is on when it goes.
    const { balance } = await this.creditState(current);
    return {
      commissionOwedCents,
      creditBalanceCents: balance,
      currency: current.currency,
    };
  }

  /**
   * Pay everything the verified track owes right now - the month part-way
   * through plus any bill already issued - without leaving the track. `payNow`
   * only clears an issued bill, which would leave a seller who wants to delete
   * mid-month with an unpayable balance and no way out.
   *
   * The month is re-anchored to today, exactly as leaving the track does, so
   * the window just paid for is never billed a second time.
   */
  async settleOutstanding(shopId: string): Promise<SubscriptionResponse> {
    const sub = await this.settle(await this.requireByShop(shopId));
    if (sub.status === 'cancelled') {
      throw new ForbiddenException(
        'This shop is cancelled. Resume it before paying.',
      );
    }
    if (sub.billingMode !== 'commission') {
      throw new BadRequestException(
        'This shop is on pre-paid credit - there is no commission to settle.',
      );
    }
    const now = new Date();
    const owed = await this.commissionOwed(sub, now);
    if (owed.total <= 0) {
      throw new BadRequestException('No payment is due.');
    }
    // Guarded on the anchor, like `settleCommission`: if the sweep bills the
    // same window concurrently, exactly one of them wins.
    const [settled] = await this.db
      .update(subscriptions)
      .set({
        dueCents: 0,
        dueSince: null,
        duePeriodStart: null,
        duePeriodEnd: null,
        dueBillableSalesCents: null,
        status: 'active',
        startedAt: now,
        nextBillingAt: addOneMonth(now, now.getDate()),
      })
      .where(
        and(
          eq(subscriptions.id, sub.id),
          eq(subscriptions.nextBillingAt, sub.nextBillingAt),
        ),
      )
      .returning();
    if (!settled) {
      throw new ConflictException(
        'Your billing just changed - refresh to see the latest state.',
      );
    }
    await this.recordClosingCommission(sub, owed, now);
    // Paying up lifts a pause the unpaid bill caused.
    await this.liftPause(sub.shopId);
    this.logger.log(
      `Shop ${shopId} settled ${owed.total / 100} BDT of outstanding commission`,
    );
    return this.toResponse(settled);
  }

  /**
   * What a shop on the verified track would have to pay to leave right now:
   * the commission earned since its current month started, plus any bill
   * already issued and still unpaid. Quoted to the console before the switch
   * and charged by it, so the seller sees the figure before agreeing to it.
   */
  private async commissionOwed(
    sub: SubscriptionRow,
    now: Date,
    executor: DbExecutor = this.db,
  ): Promise<CommissionOwed> {
    const periodStart = subOneMonth(sub.nextBillingAt, sub.startedAt.getDate());
    const billableSalesCents =
      sub.billingMode === 'commission'
        ? await this.billableSalesCents(sub, periodStart, now, executor)
        : 0;
    const accruedCents = Math.round(
      (billableSalesCents * sub.commissionBps) / 10_000,
    );
    return {
      periodStart,
      billableSalesCents,
      accruedCents,
      dueCents: sub.dueCents,
      total: accruedCents + sub.dueCents,
    };
  }

  // ── Paying a commission bill ───────────────────────────────────

  /**
   * Manual "Pay now" for a commission bill the automatic charge didn't take.
   * Settling clears the due amount and lifts a pause the unpaid bill caused;
   * the billing anchor never moves, so paying late doesn't push the next bill
   * later.
   */
  async payNow(shopId: string): Promise<SubscriptionResponse> {
    const sub = await this.settle(await this.requireByShop(shopId));
    if (sub.status === 'cancelled') {
      throw new ForbiddenException(
        'This subscription is cancelled. Resume it before paying.',
      );
    }
    if (sub.dueCents <= 0) {
      throw new BadRequestException('No payment is due.');
    }
    const now = new Date();
    // Guarded on the outstanding amount: a double-submitted "Pay now" pays once.
    const [updated] = await this.db
      .update(subscriptions)
      .set({
        dueCents: 0,
        dueSince: null,
        duePeriodStart: null,
        duePeriodEnd: null,
        status: 'active',
      })
      .where(
        and(
          eq(subscriptions.id, sub.id),
          eq(subscriptions.dueCents, sub.dueCents),
        ),
      )
      .returning();
    if (!updated) {
      throw new ConflictException(
        'This bill was just paid - refresh to see the latest state.',
      );
    }
    await this.db.insert(subscriptionPayments).values({
      userId: sub.ownerId,
      subscriptionId: sub.id,
      shopId: sub.shopId,
      type: 'commission',
      method: 'manual',
      amountCents: sub.dueCents,
      billableSalesCents: sub.dueBillableSalesCents,
      currency: sub.currency,
      periodStart: sub.duePeriodStart,
      periodEnd: sub.duePeriodEnd,
      paidAt: now,
    });
    // The pause this bill caused is lifted; a storefront the seller switched
    // off themselves stays off.
    await this.liftPause(sub.shopId);
    return this.toResponse(updated);
  }

  // ── Lifecycle ──────────────────────────────────────────────────

  /**
   * Cancel: bills whatever the verified track has earned, then stops billing
   * and forces the shop offline. The charge has to happen *before* the status
   * flips, because `settle()` skips cancelled subscriptions - without it a
   * merchant could sell all month post-paid and cancel on the last day owing
   * nothing.
   */
  async cancel(shopId: string): Promise<SubscriptionResponse> {
    const sub = await this.requireByShop(shopId);
    if (sub.status === 'cancelled') {
      return this.toResponse(sub);
    }
    await this.settleOnClose(shopId);
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
   * Resume a cancelled shop. Nothing is charged to come back: unused credit
   * is still there, and a commission shop simply starts a fresh month from
   * today, so the months spent cancelled are never billed.
   */
  async resume(shopId: string): Promise<SubscriptionResponse> {
    const sub = await this.requireByShop(shopId);
    if (sub.status !== 'cancelled') {
      return this.toResponse(await this.settle(sub));
    }
    const now = new Date();
    // Re-anchor a commission shop so the gap isn't billed as one huge month.
    // A credits shop has no anchor that matters - its balance is what counts.
    const reanchor =
      sub.billingMode === 'commission' && sub.nextBillingAt <= now;
    // Guarded on status so a double-submitted resume runs once.
    const [reactivated] = await this.db
      .update(subscriptions)
      .set({
        status: 'active',
        cancelledAt: null,
        ...(reanchor && {
          startedAt: now,
          nextBillingAt: addOneMonth(now, now.getDate()),
        }),
      })
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

  // ── Shop live toggle ───────────────────────────────────────────

  /**
   * Turn the storefront on/off. Going live needs something to sell against:
   * free orders left in the trial, credit in the balance, or the verified
   * track (which bills afterwards and so is never blocked up front) - and a
   * shop the platform has suspended cannot re-open itself at all.
   */
  async setShopLive(shopId: string, live: boolean): Promise<{ live: boolean }> {
    if (live) {
      const shop = await this.requireShop(shopId);
      if (shop.suspendedAt) {
        throw new ForbiddenException(
          shop.suspendedReason
            ? `This shop is suspended: ${shop.suspendedReason}`
            : 'This shop is suspended. Contact Hoomri support to resolve it.',
        );
      }
      const sub = await this.findByShop(shopId);
      if (sub?.status === 'cancelled') {
        throw new ForbiddenException(
          'This shop is cancelled - resume it to go live.',
        );
      }
      if (shop.plan === 'free') {
        const usage = await this.freeTierUsage(shopId);
        if (usage.ordersUsed >= FREE_ORDER_CAP) {
          throw new ForbiddenException(FREE_TIER_LIMIT_MESSAGE);
        }
      } else if (sub && sub.billingMode === 'credits') {
        const { balance } = await this.creditState(sub);
        if (balance <= 0) {
          throw new ForbiddenException(
            'Your sales credit has run out - buy a credit pack to go live again.',
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
   * Bring a subscription up to date. Runs on every console read and on the
   * hourly sweep, so a shop is never more than an hour behind.
   */
  private async settle(sub: SubscriptionRow): Promise<SubscriptionRow> {
    if (sub.status === 'cancelled') {
      return sub;
    }
    return sub.billingMode === 'commission'
      ? this.settleCommission(sub)
      : this.settleCredits(sub);
  }

  /**
   * The credits half. Nothing is ever charged here - the seller already paid.
   * All this does is notice when the balance has run out and pause the
   * storefront, and un-pause it when a top-up (or a cancelled order) puts the
   * balance back above zero.
   */
  private async settleCredits(sub: SubscriptionRow): Promise<SubscriptionRow> {
    const { balance, granted } = await this.creditState(sub);
    // A shop that has never bought anything is on the free trial, which has
    // its own limits - an empty balance is not what pauses it.
    if (granted === 0) {
      return sub;
    }
    if (balance > 0) {
      if (!sub.creditExhaustedAt) {
        return sub;
      }
      const [cleared] = await this.db
        .update(subscriptions)
        .set({ creditExhaustedAt: null })
        .where(eq(subscriptions.id, sub.id))
        .returning();
      await this.liftPause(sub.shopId);
      return cleared ?? sub;
    }

    // Balance gone. The order that crossed zero has already completed - this
    // is a pre-paid plan, so selling stops here until the seller tops up.
    let current = sub;
    if (!current.creditExhaustedAt) {
      const now = new Date();
      const [marked] = await this.db
        .update(subscriptions)
        .set({ creditExhaustedAt: now })
        .where(
          and(
            eq(subscriptions.id, sub.id),
            sql`${subscriptions.creditExhaustedAt} is null`,
          ),
        )
        .returning();
      current = marked ?? current;
      this.logger.log(`Shop ${sub.shopId} used up its sales credit - paused`);
    }
    await this.db
      .update(shops)
      .set({ live: false })
      .where(and(eq(shops.id, sub.shopId), eq(shops.live, true)));
    return current;
  }

  /**
   * The commission half. While the anchor is in the past, bill each elapsed
   * month for its billable sales and roll forward. A month that sold nothing
   * (or nothing beyond leftover credit) bills nothing and leaves no ledger
   * row. Auto-debit collects on the spot (dummy gateway); without it - or
   * when a charge doesn't land - the amount lands in `dueCents` and the
   * seller has 25 days to pay it by hand before the storefront pauses.
   */
  private async settleCommission(
    sub: SubscriptionRow,
  ): Promise<SubscriptionRow> {
    const now = new Date();
    if (sub.nextBillingAt > now) {
      return this.enforceDueGrace(sub, now);
    }
    // Only ever bill one month per settle pass: each pass re-reads the row, so
    // a shop several months behind catches up over consecutive passes without
    // this having to hold a long-running loop over the orders table.
    const anchorDay = sub.startedAt.getDate();
    const periodStart = sub.nextBillingAt;
    const periodEnd = addOneMonth(periodStart, anchorDay);
    const billableCents = await this.billableSalesCents(
      sub,
      subOneMonth(periodStart, anchorDay),
      periodStart,
    );
    const chargeCents = Math.round(
      (billableCents * sub.commissionBps) / 10_000,
    );
    const collect = sub.autoDebit && chargeCents > 0;

    // Optimistic guard: the update only wins while `nextBillingAt` is still
    // what we based the bill on. If the hourly sweep and a console read settle
    // concurrently, exactly one issues the bill - the loser simply reloads,
    // instead of billing the seller twice.
    const [updated] = await this.db
      .update(subscriptions)
      .set({
        nextBillingAt: periodEnd,
        ...(chargeCents > 0 &&
          !collect && {
            // Unpaid: add to whatever was already outstanding and start the
            // 25-day clock if it isn't already running.
            dueCents: sub.dueCents + chargeCents,
            dueSince: sub.dueSince ?? periodStart,
            duePeriodStart: sub.duePeriodStart ?? periodStart,
            duePeriodEnd: periodEnd,
            dueBillableSalesCents:
              (sub.dueBillableSalesCents ?? 0) + billableCents,
            status: 'past_due' as const,
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
      const fresh = await this.db.query.subscriptions.findFirst({
        where: eq(subscriptions.id, sub.id),
      });
      return fresh ?? sub;
    }

    if (collect) {
      await this.db.insert(subscriptionPayments).values({
        userId: sub.ownerId,
        subscriptionId: sub.id,
        shopId: sub.shopId,
        type: 'commission',
        method: 'auto',
        amountCents: chargeCents,
        billableSalesCents: billableCents,
        currency: sub.currency,
        periodStart,
        periodEnd,
        paidAt: now,
      });
      this.logger.log(
        `Shop ${sub.shopId} billed ${chargeCents / 100} BDT commission on ${billableCents / 100} BDT of sales`,
      );
    } else if (chargeCents > 0) {
      this.logger.log(
        `Shop ${sub.shopId} owes ${chargeCents / 100} BDT commission - 25-day clock running`,
      );
    }
    return this.enforceDueGrace(await this.enforceStillVerified(updated), now);
  }

  /**
   * The verified track is a credit line: we let the shop sell and bill it
   * afterwards, because its trade licence was checked. The licence is only
   * checked when a shop *joins*, so a revocation would otherwise leave it
   * selling on trust forever.
   *
   * Handled at the billing anchor rather than the moment of revocation: the
   * month just ended has been billed, so moving now costs the seller nothing
   * and interrupts no sale mid-month. They keep any credit balance and can buy
   * a pack to carry on.
   */
  private async enforceStillVerified(
    sub: SubscriptionRow,
  ): Promise<SubscriptionRow> {
    if (sub.billingMode !== 'commission') {
      return sub;
    }
    const shop = await this.db.query.shops.findFirst({
      where: eq(shops.id, sub.shopId),
      columns: { kycStatus: true },
    });
    if (!shop || shop.kycStatus === 'verified') {
      return sub;
    }
    const [moved] = await this.db
      .update(subscriptions)
      .set({ billingMode: 'credits' })
      .where(
        and(
          eq(subscriptions.id, sub.id),
          eq(subscriptions.billingMode, 'commission'),
        ),
      )
      .returning();
    this.logger.log(
      `Shop ${sub.shopId} is no longer verified - moved back to pre-paid credit`,
    );
    return moved ?? sub;
  }

  /**
   * A commission bill left unpaid past the 25-day window takes the storefront
   * offline until it is settled. Inside the window nothing changes - the shop
   * keeps selling and the seller keeps their options.
   */
  private async enforceDueGrace(
    sub: SubscriptionRow,
    now: Date,
  ): Promise<SubscriptionRow> {
    if (sub.dueCents <= 0 || !sub.dueSince) {
      return sub;
    }
    if (now.getTime() - sub.dueSince.getTime() > COMMISSION_DUE_GRACE_MS) {
      await this.db
        .update(shops)
        .set({ live: false })
        .where(and(eq(shops.id, sub.shopId), eq(shops.live, true)));
    }
    return sub;
  }

  /**
   * The sales one window's commission is charged on: what the shop sold in it,
   * less anything leftover credit covered.
   *
   * Credit is always spent first, so the split is positional - how much of the
   * running total falls inside the granted credit before the window versus
   * after it. That is what makes a shop which pre-bought ৳10,00,000 and then
   * verified sell all of it for nothing extra, with commission starting on the
   * very next taka.
   */
  private async billableSalesCents(
    sub: SubscriptionRow,
    start: Date,
    end: Date,
    executor: DbExecutor = this.db,
  ): Promise<number> {
    const [before, through] = await Promise.all([
      this.salesCents(sub.shopId, sub.meterStartAt, start, executor),
      this.salesCents(sub.shopId, sub.meterStartAt, end, executor),
    ]);
    const granted = sub.creditGrantedCents;
    const soldInWindow = Math.max(0, through - before);
    const coveredByCredit =
      Math.min(granted, through) - Math.min(granted, before);
    return Math.max(0, soldInWindow - Math.max(0, coveredByCredit));
  }

  /**
   * What a shop sold in one window: the value of every order placed in it that
   * wasn't cancelled. Cancelled orders never counted, so cancelling one gives
   * the allowance back.
   */
  private async salesCents(
    shopId: string,
    start: Date,
    end: Date,
    executor: DbExecutor = this.db,
  ): Promise<number> {
    if (end <= start) {
      return 0;
    }
    const [row] = await executor
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
   * Background sweep over every non-cancelled subscription: issues what is
   * due and checks each credits shop against its balance. It can't be narrowed
   * to subscriptions that are due - a shop that sells through its credit
   * mid-month has nothing due at all.
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
   * Lift a pause this system caused, leaving a seller's own switch-off alone.
   * A platform suspension is not ours to lift: paying a bill does not undo it,
   * so a suspended shop stays dark until the operator says otherwise.
   */
  private async liftPause(shopId: string): Promise<void> {
    await this.db
      .update(shops)
      .set({ live: true })
      .where(
        and(
          eq(shops.id, shopId),
          eq(shops.live, false),
          isNull(shops.suspendedAt),
        ),
      );
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

  private async findByShop(
    shopId: string,
  ): Promise<SubscriptionRow | undefined> {
    return this.db.query.subscriptions.findFirst({
      where: eq(subscriptions.shopId, shopId),
    });
  }

  /**
   * Load (or lazily backfill) the shop's billing record. Shops created before
   * this system get one on the credits track, its meter starting now so the
   * sales they already made never eat credit bought from here on.
   */
  private async requireByShop(shopId: string): Promise<SubscriptionRow> {
    const existing = await this.findByShop(shopId);
    if (existing) {
      return existing;
    }
    const shop = await this.requireShop(shopId);
    return this.openForNewShop(shop.ownerId, shopId);
  }

  /**
   * Free-trial usage for one shop: orders against the cap. The catalog is not
   * part of it - listing products is free and unlimited on every track, so
   * orders are the only thing the trial meters.
   */
  private async freeTierUsage(shopId: string): Promise<FreeTierUsageResponse> {
    const [{ placed }] = await this.db
      .select({
        placed: sql<string>`count(*) filter (where ${orders.status} <> 'Cancelled')`,
      })
      .from(orders)
      .where(eq(orders.shopId, shopId));
    return {
      ordersUsed: Number(placed),
      ordersCap: FREE_ORDER_CAP,
    };
  }

  private async toResponse(
    sub: SubscriptionRow,
  ): Promise<SubscriptionResponse> {
    const anchorDay = sub.startedAt.getDate();
    // The month a commission bill is accruing for: the one ending on the next
    // anchor. On the credits track it is only shown for context.
    const period = {
      start: subOneMonth(sub.nextBillingAt, anchorDay),
      end: sub.nextBillingAt,
    };
    const [shop, payments, packs, credit, billableSalesCents] =
      await Promise.all([
        this.db.query.shops.findFirst({
          where: eq(shops.id, sub.shopId),
          columns: { live: true, plan: true, kycStatus: true },
        }),
        this.db.query.subscriptionPayments.findMany({
          where: eq(subscriptionPayments.subscriptionId, sub.id),
          orderBy: [desc(subscriptionPayments.paidAt)],
        }),
        this.billing.packs(),
        this.creditState(sub),
        this.billableSalesCents(sub, period.start, new Date()),
      ]);
    const tier = shop?.plan ?? 'free';
    return SubscriptionResponse.fromRows(sub, shop?.live ?? false, payments, {
      tier,
      freeTier:
        tier === 'free' ? await this.freeTierUsage(sub.shopId) : undefined,
      kycStatus: shop?.kycStatus ?? 'unsubmitted',
      canUseCommission: shop?.kycStatus === 'verified',
      packs,
      creditCapCents: CREDIT_BALANCE_CAP_CENTS,
      granted: credit.granted,
      used: credit.used,
      period,
      billableSalesCents,
      dueGraceMs: COMMISSION_DUE_GRACE_MS,
    });
  }
}
