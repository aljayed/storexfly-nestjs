import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  MONTHLY_FEE_CENTS,
  PLATFORM_CURRENCY,
} from '../../common/constants/billing';
import { isUniqueViolation } from '../../common/utils/postgres-error.util';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import {
  coupons,
  subscriptionPayments,
  type CouponRow,
} from '../../database/schema';
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
  description: '75% off the first payment when creating a shop',
};

/** Why a coupon cannot be redeemed right now (seller-facing copy). */
type RejectReason =
  | 'not_found'
  | 'inactive'
  | 'expired'
  | 'exhausted'
  | 'already_used';

const REJECT_COPY: Record<RejectReason, string> = {
  not_found: 'That coupon code does not exist.',
  inactive: 'This coupon is no longer active.',
  expired: 'This coupon has expired.',
  exhausted: 'This coupon has reached its redemption limit.',
  already_used: 'You have already used this coupon.',
};

export type CouponCheck =
  | { ok: true; coupon: CouponRow; discountCents: number }
  | { ok: false; reason: RejectReason };

/**
 * Platform coupons. Coupons apply only to the one-off shop-creation fee —
 * a seller's first subscription payment — never to monthly renewals, and a
 * seller can redeem any given code once.
 */
@Injectable()
export class CouponsService implements OnModuleInit {
  private readonly logger = new Logger(CouponsService.name);

  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async onModuleInit(): Promise<void> {
    try {
      const inserted = await this.db
        .insert(coupons)
        .values(DEFAULT_COUPON)
        .onConflictDoNothing({ target: coupons.code })
        .returning({ id: coupons.id });
      if (inserted.length > 0) {
        this.logger.log(`Seeded default coupon ${DEFAULT_COUPON.code}`);
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

  // ── Redemption (shop-creation fee only) ────────────────────────

  /**
   * Can `userId` redeem `code` against the shop-creation fee right now?
   * Checks existence, active flag, expiry, the global cap and one-per-seller
   * use; on success returns the coupon and the discount in paisa.
   */
  async checkForShopCreation(
    code: string,
    userId: string,
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
    const priorUse = await this.db.query.subscriptionPayments.findFirst({
      where: and(
        eq(subscriptionPayments.userId, userId),
        eq(subscriptionPayments.couponId, coupon.id),
      ),
      columns: { id: true },
    });
    if (priorUse) return { ok: false, reason: 'already_used' };

    const discountCents = Math.round(
      (MONTHLY_FEE_CENTS * coupon.percentOff) / 100,
    );
    return { ok: true, coupon, discountCents };
  }

  /** Seller-facing dry run for the onboarding wizard's coupon field. */
  async preview(code: string, userId: string): Promise<CouponPreviewResponse> {
    const check = await this.checkForShopCreation(code, userId);
    if (!check.ok) {
      return {
        valid: false,
        amount: MONTHLY_FEE_CENTS / 100,
        total: MONTHLY_FEE_CENTS / 100,
        currency: PLATFORM_CURRENCY,
        reason: REJECT_COPY[check.reason],
      };
    }
    return {
      valid: true,
      code: check.coupon.code,
      percentOff: check.coupon.percentOff,
      amount: MONTHLY_FEE_CENTS / 100,
      discount: check.discountCents / 100,
      total: (MONTHLY_FEE_CENTS - check.discountCents) / 100,
      currency: PLATFORM_CURRENCY,
    };
  }

  /** Human-readable rejection message for a failed check. */
  rejectionMessage(reason: RejectReason): string {
    return REJECT_COPY[reason];
  }

  /** Count a successful redemption against the coupon's global cap. */
  async markRedeemed(couponId: string): Promise<void> {
    await this.db
      .update(coupons)
      .set({ redemptions: sql`${coupons.redemptions} + 1` })
      .where(eq(coupons.id, couponId));
  }
}
