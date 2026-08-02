import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { PLATFORM_CURRENCY } from '../../common/constants/billing';
import { isUniqueViolation } from '../../common/utils/postgres-error.util';
import { DRIZZLE } from '../../database/database.constants';
import type { DbExecutor, DrizzleDB } from '../../database/drizzle.types';
import { coupons, orders, shops, type CouponRow } from '../../database/schema';
import { BillingSettingsService } from '../billing/billing-settings.service';
import type { CreateCouponDto } from './dto/create-coupon.dto';
import { CouponPreviewResponse, CouponResponse } from './dto/coupon.response';

/**
 * The default platform coupon: 75% off a seller's first payment (the
 * shop-creation fee). Ensured at boot so it survives database resets and is
 * always available unless an operator deactivates or deletes it.
 */
const DEFAULT_COUPON = {
  code: 'HOOMRI75',
  percentOff: 75,
  description: "75% off a seller's first payment",
};

/**
 * The launch offer on credit packs. The landing page advertises this code, but
 * only while it is genuinely redeemable - see {@link CouponsService.launchOffer}
 * - so deactivating or deleting it here takes the offer off the page too.
 */
export const LAUNCH_COUPON = {
  code: 'LAUNCH50',
  percentOff: 50,
  description: 'Launch offer: 50% off any credit pack',
};

/** Why a coupon cannot be redeemed right now (seller-facing copy). */
type RejectReason =
  | 'not_found'
  | 'inactive'
  | 'expired'
  | 'exhausted'
  | 'high_sales';

const REJECT_COPY: Record<RejectReason, string> = {
  not_found: 'That coupon code does not exist.',
  inactive: 'This coupon is no longer active.',
  expired: 'This coupon has expired.',
  exhausted: 'This coupon has reached its redemption limit.',
  high_sales:
    'Coupons are not available to sellers with ৳100,000 or more in sales in the last 30 days.',
};

/** Sellers whose shop sold this much (paisa) in the last 30 days get no coupons. */
const HIGH_SALES_THRESHOLD_CENTS = 100_000 * 100;

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export type CouponCheck =
  | { ok: true; coupon: CouponRow; discountCents: number }
  | { ok: false; reason: RejectReason };

/**
 * Platform coupons. A coupon discounts a single subscription payment - the
 * one-off shop-creation fee, or (applied from the console) a shop's next
 * monthly renewal. A seller can redeem the same code repeatedly; instead,
 * coupons are withheld from high-volume sellers (any shop with ≥৳100,000 in
 * paid sales over the last 30 days).
 */
@Injectable()
export class CouponsService implements OnModuleInit {
  private readonly logger = new Logger(CouponsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly billing: BillingSettingsService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      const inserted = await this.db
        .insert(coupons)
        .values([DEFAULT_COUPON, LAUNCH_COUPON])
        .onConflictDoNothing({ target: coupons.code })
        .returning({ code: coupons.code });
      for (const row of inserted) {
        this.logger.log(`Seeded coupon ${row.code}`);
      }
    } catch (err) {
      this.logger.error('Failed to ensure default coupon', err as Error);
    }
  }

  // ── Platform-admin CRUD ────────────────────────────────────────

  async list(): Promise<CouponResponse[]> {
    const rows = await this.db.query.coupons.findMany({
      orderBy: [desc(coupons.createdAt)],
    });
    return rows.map(CouponResponse.fromRow);
  }

  async create(dto: CreateCouponDto): Promise<CouponResponse> {
    try {
      const [row] = await this.db
        .insert(coupons)
        .values({
          code: dto.code.toUpperCase(),
          percentOff: dto.percentOff,
          description: dto.description,
          maxRedemptions: dto.maxRedemptions,
          expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
        })
        .returning();
      return CouponResponse.fromRow(row);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException('A coupon with that code already exists');
      }
      throw err;
    }
  }

  async setActive(id: string, active: boolean): Promise<CouponResponse> {
    const [row] = await this.db
      .update(coupons)
      .set({ active })
      .where(eq(coupons.id, id))
      .returning();
    if (!row) {
      throw new NotFoundException('Coupon not found');
    }
    return CouponResponse.fromRow(row);
  }

  async remove(id: string): Promise<{ deleted: true }> {
    const [row] = await this.db
      .delete(coupons)
      .where(eq(coupons.id, id))
      .returning({ id: coupons.id });
    if (!row) {
      throw new NotFoundException('Coupon not found');
    }
    return { deleted: true };
  }

  /**
   * The launch offer, or null when it isn't redeemable right now - deleted,
   * deactivated, expired or fully redeemed. The public pricing route serves
   * this, so the landing page never advertises a code that would be refused
   * at checkout.
   */
  async launchOffer(): Promise<{ code: string; percentOff: number } | null> {
    try {
      const row = await this.db.query.coupons.findFirst({
        where: eq(coupons.code, LAUNCH_COUPON.code),
      });
      if (!row || !row.active) return null;
      if (row.expiresAt && row.expiresAt <= new Date()) return null;
      if (
        row.maxRedemptions !== null &&
        row.redemptions >= row.maxRedemptions
      ) {
        return null;
      }
      return { code: row.code, percentOff: row.percentOff };
    } catch {
      // A catalogue hiccup should quiet the offer, never break the page.
      return null;
    }
  }

  // ── Redemption ─────────────────────────────────────────────────

  /**
   * Can `userId` redeem `code` against a payment of `amountCents` right now?
   * Checks existence, active flag, expiry, the global cap, and that none of
   * the seller's shops crossed the high-sales threshold in the last 30 days
   * (repeat use of the same code is fine); on success returns the coupon and
   * the discount in paisa.
   */
  async check(
    code: string,
    userId: string,
    amountCents: number,
  ): Promise<CouponCheck> {
    const coupon = await this.db.query.coupons.findFirst({
      where: eq(coupons.code, code.trim().toUpperCase()),
    });
    if (!coupon) return { ok: false, reason: 'not_found' };
    if (!coupon.active) return { ok: false, reason: 'inactive' };
    if (coupon.expiresAt && coupon.expiresAt <= new Date()) {
      return { ok: false, reason: 'expired' };
    }
    if (
      coupon.maxRedemptions !== null &&
      coupon.redemptions >= coupon.maxRedemptions
    ) {
      return { ok: false, reason: 'exhausted' };
    }
    const since = new Date(Date.now() - THIRTY_DAYS_MS);
    const highSalesShop = await this.db
      .select({ shopId: orders.shopId })
      .from(orders)
      .innerJoin(shops, eq(orders.shopId, shops.id))
      .where(
        and(
          eq(shops.ownerId, userId),
          eq(orders.pay, 'Paid'),
          gte(orders.placedAt, since),
        ),
      )
      .groupBy(orders.shopId)
      .having(
        gte(sql`sum(${orders.totalCents})`, sql`${HIGH_SALES_THRESHOLD_CENTS}`),
      )
      .limit(1);
    if (highSalesShop.length > 0) return { ok: false, reason: 'high_sales' };

    // Round the discount up to a whole taka so the price after the coupon is
    // a whole amount (৳599 at 75% → ৳150, not ৳149.75).
    const discountCents =
      Math.ceil((amountCents * coupon.percentOff) / 100 / 100) * 100;
    return { ok: true, coupon, discountCents };
  }

  /**
   * Seller-facing dry run for the coupon field at credit-pack checkout.
   * Defaults to the entry pack's price, which is what the console quotes
   * before the seller has picked a pack.
   */
  async preview(
    code: string,
    userId: string,
    amountCents?: number,
  ): Promise<CouponPreviewResponse> {
    const feeCents =
      amountCents ?? (await this.billing.entryPack())?.priceCents ?? 0;
    const check = await this.check(code, userId, feeCents);
    if (!check.ok) {
      return {
        valid: false,
        amount: feeCents / 100,
        total: feeCents / 100,
        currency: PLATFORM_CURRENCY,
        reason: REJECT_COPY[check.reason],
      };
    }
    return {
      valid: true,
      code: check.coupon.code,
      percentOff: check.coupon.percentOff,
      amount: feeCents / 100,
      discount: check.discountCents / 100,
      total: (feeCents - check.discountCents) / 100,
      currency: PLATFORM_CURRENCY,
    };
  }

  /** Human-readable rejection message for a failed check. */
  rejectionMessage(reason: RejectReason): string {
    return REJECT_COPY[reason];
  }

  /** Count a successful redemption against the coupon's global cap. */
  async markRedeemed(couponId: string, executor?: DbExecutor): Promise<void> {
    await (executor ?? this.db)
      .update(coupons)
      .set({ redemptions: sql`${coupons.redemptions} + 1` })
      .where(eq(coupons.id, couponId));
  }

  /** Give back a redemption when a pending (not yet charged) coupon is removed. */
  async release(couponId: string, executor?: DbExecutor): Promise<void> {
    await (executor ?? this.db)
      .update(coupons)
      .set({
        redemptions: sql`greatest(${coupons.redemptions} - 1, 0)`,
      })
      .where(eq(coupons.id, couponId));
  }
}
