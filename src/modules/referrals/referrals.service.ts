import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { PLATFORM_CURRENCY } from '../../common/constants/billing';
import { isUniqueViolation } from '../../common/utils/postgres-error.util';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import { coupons, referralLinks } from '../../database/schema';
import { BillingSettingsService } from '../billing/billing-settings.service';
import type { CreateReferralLinkDto } from './dto/create-referral-link.dto';
import {
  ReferralLinkResponse,
  ReferralResolveResponse,
} from './dto/referral-link.response';

/**
 * Referral links (hoomri.com/r/<slug>), each tied to a platform coupon.
 * Opening a link quotes the discounted first month and hands the storefront
 * the coupon code to auto-apply on the shop-creation payment. The discount
 * never touches renewals - those are charged at full price unless a coupon
 * is applied manually from the seller console.
 */
@Injectable()
export class ReferralsService {
  private readonly logger = new Logger(ReferralsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly billing: BillingSettingsService,
  ) {}

  // ── Platform-admin CRUD ────────────────────────────────────────

  async list(): Promise<ReferralLinkResponse[]> {
    const rows = await this.db.query.referralLinks.findMany({
      with: { coupon: true },
      orderBy: [desc(referralLinks.createdAt)],
    });
    return rows.map((row) => ReferralLinkResponse.fromRow(row));
  }

  async create(dto: CreateReferralLinkDto): Promise<ReferralLinkResponse> {
    const coupon = await this.db.query.coupons.findFirst({
      where: eq(coupons.id, dto.couponId),
    });
    if (!coupon) {
      throw new BadRequestException('That coupon does not exist');
    }
    try {
      const [row] = await this.db
        .insert(referralLinks)
        .values({
          slug: dto.slug.trim().toLowerCase(),
          name: dto.name?.trim() || undefined,
          couponId: coupon.id,
        })
        .returning();
      return ReferralLinkResponse.fromRow({ ...row, coupon });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          'A referral link with that slug already exists',
        );
      }
      throw err;
    }
  }

  async setActive(id: string, active: boolean): Promise<ReferralLinkResponse> {
    const [row] = await this.db
      .update(referralLinks)
      .set({ active })
      .where(eq(referralLinks.id, id))
      .returning();
    if (!row) {
      throw new NotFoundException('Referral link not found');
    }
    const coupon = await this.db.query.coupons.findFirst({
      where: eq(coupons.id, row.couponId),
    });
    if (!coupon) {
      throw new NotFoundException('Referral link not found');
    }
    return ReferralLinkResponse.fromRow({ ...row, coupon });
  }

  async remove(id: string): Promise<{ deleted: true }> {
    const [row] = await this.db
      .delete(referralLinks)
      .where(eq(referralLinks.id, id))
      .returning({ id: referralLinks.id });
    if (!row) {
      throw new NotFoundException('Referral link not found');
    }
    return { deleted: true };
  }

  // ── Public resolution ──────────────────────────────────────────

  /**
   * Look up an active link by slug, count the click, and quote what its
   * coupon does to the first month. 404s whenever the link (or its coupon)
   * can't currently give a discount, so the storefront simply renders the
   * regular pricing. The seller-specific checks (high-sales cutoff) and the
   * final price run again at payment time - this is only a quote.
   */
  async resolve(slug: string): Promise<ReferralResolveResponse> {
    const link = await this.db.query.referralLinks.findFirst({
      where: eq(referralLinks.slug, slug.trim().toLowerCase()),
      with: { coupon: true },
    });
    const coupon = link?.coupon;
    const usable =
      link?.active &&
      coupon?.active &&
      (!coupon.expiresAt || coupon.expiresAt > new Date()) &&
      (coupon.maxRedemptions === null ||
        coupon.redemptions < coupon.maxRedemptions);
    if (!link || !coupon || !usable) {
      throw new NotFoundException('Referral link not found');
    }

    await this.db
      .update(referralLinks)
      .set({ clicks: sql`${referralLinks.clicks} + 1` })
      .where(eq(referralLinks.id, link.id));

    // Quoted against the entry pack - the cheapest way in, and what the
    // landing page's "from ৳X" refers to.
    const feeCents = (await this.billing.entryPack())?.priceCents ?? 0;
    // Same rounding as CouponsService.check: discount up to a whole taka.
    const discountCents =
      Math.ceil((feeCents * coupon.percentOff) / 100 / 100) * 100;
    return {
      slug: link.slug,
      code: coupon.code,
      percentOff: coupon.percentOff,
      packPrice: feeCents / 100,
      discount: discountCents / 100,
      firstPaymentTotal: (feeCents - discountCents) / 100,
      currency: PLATFORM_CURRENCY,
    };
  }

  /**
   * Attribute a paid first payment to the link that carried the coupon.
   * Only counts when the slug still maps to that exact coupon, so a code
   * typed in by hand can't inflate an unrelated link. Never throws - the
   * payment has already succeeded.
   */
  async recordSignup(slug: string, couponId: string): Promise<void> {
    try {
      await this.db
        .update(referralLinks)
        .set({ signups: sql`${referralLinks.signups} + 1` })
        .where(
          and(
            eq(referralLinks.slug, slug.trim().toLowerCase()),
            eq(referralLinks.couponId, couponId),
          ),
        );
    } catch (err) {
      this.logger.error(
        `Failed to record referral signup for "${slug}"`,
        err as Error,
      );
    }
  }
}
