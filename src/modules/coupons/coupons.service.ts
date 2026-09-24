import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { and, desc, eq, gte, or, sql } from 'drizzle-orm';
import { PLATFORM_CURRENCY } from '../../common/constants/billing';
import { isUniqueViolation } from '../../common/utils/postgres-error.util';
import { DRIZZLE } from '../../database/database.constants';
import type { DbExecutor, DrizzleDB } from '../../database/drizzle.types';
import {
  coupons,
  orders,
  shops,
  subscriptionPayments,
  users,
  type CouponRow,
} from '../../database/schema';
import { BillingSettingsService } from '../billing/billing-settings.service';
import { normalizeHandle } from '../buyer/handle.util';
import type { CreateCouponDto, UpdateCouponDto } from './dto/create-coupon.dto';
import {
  CouponPreviewResponse,
  CouponResponse,
  type CouponUserView,
} from './dto/coupon.response';

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
  | 'wrong_user'
  | 'wrong_pack'
  | 'not_first_purchase'
  | 'high_sales';

const REJECT_COPY: Record<RejectReason, string> = {
  not_found: 'That coupon code does not exist.',
  inactive: 'This coupon is no longer active.',
  expired: 'This coupon has expired.',
  exhausted: 'This coupon has reached its redemption limit.',
  // Worded like not_found on purpose: a personal code should not confirm to
  // anyone else that it exists.
  wrong_user: 'This coupon is not available on your account.',
  wrong_pack: 'This coupon does not apply to this credit pack.',
  not_first_purchase: 'This coupon is only for your first credit purchase.',
  high_sales:
    'Coupons are not available to sellers with ৳100,000 or more in sales in the last 30 days.',
};

/** Sellers whose shop sold this much (paisa) in the last 30 days get no coupons. */
const HIGH_SALES_THRESHOLD_CENTS = 100_000 * 100;

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export type CouponCheck =
  | { ok: true; coupon: CouponRow; discountCents: number }
  | { ok: false; reason: RejectReason; message: string };

/** The pack a coupon is being checked against. */
export interface CouponPack {
  code: string;
  priceCents: number;
}

/** Discount rounded up to a whole taka (৳599 at 75% → ৳450 off, pay ৳149). */
export function couponDiscountCents(
  amountCents: number,
  percentOff: number,
): number {
  return Math.ceil((amountCents * percentOff) / 100 / 100) * 100;
}

const USER_COLUMNS = {
  id: true,
  name: true,
  handle: true,
  publicId: true,
} as const;

/**
 * Platform coupons. A coupon discounts a single credit-pack purchase - the
 * one that opens a shop, or a top-up from the console. A seller can redeem the
 * same code repeatedly; instead, coupons are withheld from high-volume sellers
 * (any shop with ≥৳100,000 in paid sales over the last 30 days).
 *
 * The operator can narrow a coupon further: to a seller's first purchase, to
 * one seller's account, and to particular packs. Each is checked at preview,
 * at the buy click and again when the money lands.
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
      with: { user: { columns: USER_COLUMNS } },
      orderBy: [desc(coupons.createdAt)],
    });
    return rows.map((row) => CouponResponse.fromRow(row));
  }

  async create(dto: CreateCouponDto): Promise<CouponResponse> {
    const user = dto.user ? await this.resolveSeller(dto.user) : null;
    const packCodes = await this.validPackCodes(dto.packCodes);
    try {
      const [row] = await this.db
        .insert(coupons)
        .values({
          code: dto.code.toUpperCase(),
          percentOff: dto.percentOff,
          description: dto.description,
          maxRedemptions: dto.maxRedemptions,
          expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
          firstPurchaseOnly: dto.firstPurchaseOnly ?? false,
          userId: user?.id ?? null,
          packCodes,
        })
        .returning();
      return CouponResponse.fromRow({ ...row, user });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException('A coupon with that code already exists');
      }
      throw err;
    }
  }

  /**
   * Change anything but the code. Tightening a rule only affects purchases
   * from here on: a payment already sent to the gateway is re-checked when it
   * settles, and if the coupon no longer stands it is simply not counted.
   */
  async update(id: string, dto: UpdateCouponDto): Promise<CouponResponse> {
    const set: Partial<typeof coupons.$inferInsert> = {};
    if (dto.active !== undefined) set.active = dto.active;
    if (dto.percentOff !== undefined) set.percentOff = dto.percentOff;
    if (dto.description !== undefined) {
      set.description = dto.description?.trim() || null;
    }
    if (dto.maxRedemptions !== undefined) {
      set.maxRedemptions = dto.maxRedemptions;
    }
    if (dto.expiresAt !== undefined) {
      set.expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;
    }
    if (dto.firstPurchaseOnly !== undefined) {
      set.firstPurchaseOnly = dto.firstPurchaseOnly;
    }
    if (dto.user !== undefined) {
      set.userId = dto.user ? (await this.resolveSeller(dto.user)).id : null;
    }
    if (dto.packCodes !== undefined) {
      set.packCodes = await this.validPackCodes(dto.packCodes);
    }
    if (Object.keys(set).length) {
      const [row] = await this.db
        .update(coupons)
        .set(set)
        .where(eq(coupons.id, id))
        .returning({ id: coupons.id });
      if (!row) {
        throw new NotFoundException('Coupon not found');
      }
    }
    const row = await this.db.query.coupons.findFirst({
      where: eq(coupons.id, id),
      with: { user: { columns: USER_COLUMNS } },
    });
    if (!row) {
      throw new NotFoundException('Coupon not found');
    }
    return CouponResponse.fromRow(row);
  }

  async setActive(id: string, active: boolean): Promise<CouponResponse> {
    return this.update(id, { active });
  }

  /**
   * The account an operator means by "@rafiq", "rafiq" or "HM7K3PQR9X". A
   * handle is tried first - it is what sellers show one another - then the
   * permanent public ID, which every account has even without a handle.
   */
  private async resolveSeller(ref: string): Promise<CouponUserView> {
    const raw = ref.trim();
    const handle = normalizeHandle(raw);
    const byHandle = eq(users.handle, handle);
    const found = await this.db.query.users.findFirst({
      where: raw.startsWith('@')
        ? byHandle
        : or(byHandle, eq(users.publicId, raw.toUpperCase())),
      columns: USER_COLUMNS,
    });
    if (!found) {
      throw new BadRequestException(
        raw.startsWith('@')
          ? `No account has the handle ${raw}.`
          : `No account has the handle @${handle} or the account ID ${raw.toUpperCase()}.`,
      );
    }
    return found;
  }

  /**
   * The pack codes a coupon is limited to, checked against the catalogue.
   * Empty means any pack, stored as null so "any" has one spelling.
   */
  private async validPackCodes(
    codes: string[] | null | undefined,
  ): Promise<string[] | null> {
    const wanted = [...new Set((codes ?? []).map((c) => c.trim()))].filter(
      Boolean,
    );
    if (!wanted.length) return null;
    const known = new Set((await this.billing.allPacks()).map((p) => p.code));
    const unknown = wanted.filter((c) => !known.has(c));
    if (unknown.length) {
      throw new BadRequestException(
        `No credit pack has the code ${unknown.join(', ')}.`,
      );
    }
    return wanted;
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
      // A personal code is never advertised to everybody.
      if (row.userId) return null;
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
   * Can `userId` redeem `code` against `pack` right now? Checks existence,
   * active flag, expiry, the global cap, the operator's narrowing rules (one
   * seller, some packs, first purchase only), and that none of the seller's
   * shops crossed the high-sales threshold in the last 30 days (repeat use of
   * the same code is fine); on success returns the coupon and the discount in
   * paisa.
   *
   * Runs again when a payment settles, *before* that purchase is written to
   * the ledger - so a first-purchase coupon still stands for the very
   * purchase it was bought with.
   */
  async check(
    code: string,
    userId: string,
    pack: CouponPack,
  ): Promise<CouponCheck> {
    const coupon = await this.db.query.coupons.findFirst({
      where: eq(coupons.code, code.trim().toUpperCase()),
    });
    const reject = async (reason: RejectReason): Promise<CouponCheck> => ({
      ok: false,
      reason,
      message:
        reason === 'wrong_pack' && coupon?.packCodes?.length
          ? await this.wrongPackMessage(coupon.packCodes)
          : REJECT_COPY[reason],
    });
    if (!coupon) return reject('not_found');
    if (!coupon.active) return reject('inactive');
    if (coupon.expiresAt && coupon.expiresAt <= new Date()) {
      return reject('expired');
    }
    if (
      coupon.maxRedemptions !== null &&
      coupon.redemptions >= coupon.maxRedemptions
    ) {
      return reject('exhausted');
    }
    if (coupon.userId && coupon.userId !== userId) {
      return reject('wrong_user');
    }
    if (coupon.packCodes?.length && !coupon.packCodes.includes(pack.code)) {
      return reject('wrong_pack');
    }
    if (coupon.firstPurchaseOnly && (await this.hasPaidBefore(userId))) {
      return reject('not_first_purchase');
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
    if (highSalesShop.length > 0) return reject('high_sales');

    // Round the discount up to a whole taka so the price after the coupon is
    // a whole amount.
    const discountCents = couponDiscountCents(
      pack.priceCents,
      coupon.percentOff,
    );
    return { ok: true, coupon, discountCents };
  }

  /**
   * Has this account ever had a platform payment - a credit pack on any of
   * its shops (free ones included, so a 100%-off first-purchase code cannot
   * be taken twice) or a commission bill? That is what "not new" means.
   */
  private async hasPaidBefore(userId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: subscriptionPayments.id })
      .from(subscriptionPayments)
      .where(eq(subscriptionPayments.userId, userId))
      .limit(1);
    return !!row;
  }

  /** "This coupon only works on the ৳2,00,000 in sales pack." */
  private async wrongPackMessage(packCodes: string[]): Promise<string> {
    const names = (await this.billing.allPacks())
      .filter((p) => packCodes.includes(p.code))
      .map((p) => p.name);
    if (!names.length) return REJECT_COPY.wrong_pack;
    const list =
      names.length === 1
        ? names[0]
        : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
    return `This coupon only works on the ${list} pack${names.length === 1 ? '' : 's'}.`;
  }

  /**
   * Seller-facing dry run for the coupon field at credit-pack checkout.
   * Defaults to the entry pack's price, which is what the console quotes
   * before the seller has picked a pack.
   */
  async preview(
    code: string,
    userId: string,
    pack?: CouponPack | null,
  ): Promise<CouponPreviewResponse> {
    const target = pack ?? (await this.billing.entryPack());
    const feeCents = target?.priceCents ?? 0;
    const check = await this.check(code, userId, {
      code: target?.code ?? '',
      priceCents: feeCents,
    });
    if (!check.ok) {
      return {
        valid: false,
        amount: feeCents / 100,
        total: feeCents / 100,
        currency: PLATFORM_CURRENCY,
        reason: check.message,
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
